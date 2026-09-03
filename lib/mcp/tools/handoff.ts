/**
 * MCP special tool — crm_request_human_handoff (Spec 11 §3.3).
 *
 * Side effects: TODOS delegados ao `triggerHandoff` (lib/ai/handoff/orchestrator).
 * Esta tool é uma casca fina: valida a entrada, acha o lead, chama o orquestrador
 * e traduz o resultado pra IA.
 *   - conversations.status='pending', bot_silenced_until='infinity'
 *   - crm_lead_activities INSERT (type='handoff_triggered') quando há lead vinculado
 *   - event_log INSERT event_type='ai.handoff_triggered'
 *   - Realtime broadcast `org:<org>:queue` event=handoff_pending
 *   - api_audit_log action='ai.handoff_triggered'
 *   - atribuição do corretor + aviso por WhatsApp/push
 *
 * A atribuição e o aviso moravam AQUI, e por isso só o handoff decidido pela IA
 * avisava alguém: lead que digitava "quero falar com atendente" calava o bot e
 * ninguém era notificado. Foram pro orquestrador (passo 6) pra valer em todo
 * gatilho. Não reintroduzir aqui, viraria aviso em dobro.
 *
 * Nenhum mirror REST. Wave 4 introduz como tool MCP only.
 */
import { z } from "zod";

import { triggerHandoff } from "@/lib/ai/handoff/orchestrator";
import type { McpToolDefinition } from "../types";

const inputShape = {
  conversation_id: z.string().uuid(),
  reason: z.string().min(1).max(500).default("requested_human"),
  urgency: z.enum(["low", "normal", "high"]).default("normal"),
  suggested_assignee_role: z
    .enum(["agent", "manager", "admin"])
    .optional()
    .default("agent"),
  metadata: z.record(z.string(), z.unknown()).optional(),
};

export const crmRequestHumanHandoff: McpToolDefinition<typeof inputShape> = {
  name: "crm_request_human_handoff",
  description:
    "Aciona handoff bot→humano. Marca a conversa como pending, silencia o bot, atribui round-robin a um agente disponível, registra activity + event_log + audit. Use quando o cliente pedir atendente humano ou o agente identificar limite da automação.",
  inputSchema: inputShape,
  category: "handoff",
  requiresRole: "agent",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    // Conversation must belong to org (defense in depth — service role bypassa RLS).
    const { data: conv, error: convErr } = await ctx.supabase
      .from("conversations")
      .select("id, organization_id, contact_id")
      .eq("id", input.conversation_id)
      .maybeSingle();
    if (convErr) throw new Error(convErr.message);
    if (!conv || conv.organization_id !== ctx.organizationId) {
      throw new Error("conversation_not_found");
    }

    // Try to find a lead linked to this contact (best effort for activity insert).
    let leadId: string | null = null;
    if (conv.contact_id) {
      const { data: leadRow } = await ctx.supabase
        .from("crm_leads")
        .select("id")
        .eq("organization_id", ctx.organizationId)
        .eq("contact_id", conv.contact_id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      leadId = leadRow?.id ?? null;
    }

    const result = await triggerHandoff({
      conversationId: input.conversation_id,
      organizationId: ctx.organizationId,
      reason: "requested_human",
      leadId,
      minAssigneeRole: input.suggested_assignee_role ?? "agent",
      metadata: {
        source: "ai_agent",
        urgency: input.urgency,
        original_reason: input.reason,
        ...(ctx.actor.type === "ai_agent" ? { run_id: ctx.actor.id } : {}),
        ...(input.metadata ?? {}),
      },
    });

    // Atribuição + aviso ao corretor agora vivem no orquestrador (passo 6), pra
    // que TODO gatilho de handoff avise, não só este. Aqui só lemos o resultado.
    const assignedUserId = result.assignedUserId ?? null;
    const assignedFirstName = result.assignedFirstName ?? null;
    const rotationActive = result.rotationActive ?? false;

    return {
      handoff_recorded: result.triggered,
      conversation_id: input.conversation_id,
      assigned_to_user_id: assignedUserId,
      assigned_to_name: assignedFirstName,
      rotation_active: rotationActive,
      idempotent: !result.triggered && result.reason === "idempotent_5s",
      next_action: assignedFirstName
        ? `Avise o cliente, em tom acolhedor, que ${assignedFirstName} vai assumir o atendimento em instantes. Cite o nome ${assignedFirstName}.`
        : "Avise o cliente em tom acolhedor que um atendente humano vai assumir em instantes.",
    };
  },
};
