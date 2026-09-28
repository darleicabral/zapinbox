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

/**
 * O handoff deve ESPERAR porque o cliente falou DEPOIS que o run leu o histórico?
 *
 * 🐛 25/09/2026 (Tete) — a cliente disse "Pod ser segunda feira", o run começou
 * (leu "segunda") e ~1 min depois, DURANTE o run, corrigiu pra "Domingo". O run
 * terminou gravando "segunda" e o handoff silenciou a conversa, jogando a
 * correção fora ("skipped_silenced"). Comparando a última fala do lead com o
 * INÍCIO do run: se ela é mais nova, o run não a viu — não encaminha (nem
 * silencia), e deixa a correção rodar num run fresco, que lê o dia certo.
 *
 * Só o handoff decidido pela IA passa por aqui; o pedido explícito por
 * palavra-chave/sentinela tem outro caminho e não é afetado.
 */
export function handoffDeveEsperar(
  runCreatedAt: string | null,
  lastInboundAt: string | null,
): boolean {
  if (!runCreatedAt || !lastInboundAt) return false;
  return new Date(lastInboundAt).getTime() > new Date(runCreatedAt).getTime();
}

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
      .select("id, organization_id, contact_id, last_inbound_at")
      .eq("id", input.conversation_id)
      .maybeSingle();
    if (convErr) throw new Error(convErr.message);
    if (!conv || conv.organization_id !== ctx.organizationId) {
      throw new Error("conversation_not_found");
    }

    // Guarda de corrida: se o cliente mandou mensagem DEPOIS que este run começou
    // (leu o histórico), o contexto que decidiu encaminhar está velho — ex.: ele
    // trocou "segunda" por "domingo" enquanto o run rodava (a Tete, 25/09). Não
    // encaminha e NÃO silencia: a mensagem nova roda num run fresco, que lê a
    // correção. Só pro handoff da IA (tem run_id no ator).
    if (ctx.actor.type === "ai_agent") {
      const { data: run } = await ctx.supabase
        .from("ai_agent_runs")
        .select("created_at")
        .eq("id", ctx.actor.id)
        .eq("organization_id", ctx.organizationId)
        .maybeSingle();
      const lastInboundAt = (conv as { last_inbound_at?: string | null }).last_inbound_at ?? null;
      if (handoffDeveEsperar(run?.created_at ?? null, lastInboundAt)) {
        return {
          handoff_recorded: false,
          deferred_newer_inbound: true,
          conversation_id: input.conversation_id,
          next_action:
            "O cliente enviou uma mensagem DEPOIS do que você leu. NÃO encaminhe e NÃO confirme dia/horário agora. Encerre esta resposta de leve (ex.: 'só um instante 😊') — a mensagem nova vai ser lida em seguida e o encaminhamento acontece quando o dia/horário estiver confirmado.",
        };
      }
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
