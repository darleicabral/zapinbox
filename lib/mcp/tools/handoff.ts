/**
 * MCP special tool — crm_request_human_handoff (Spec 11 §3.3).
 *
 * Side effects (todos via `triggerHandoff` orchestrator + assignment best-effort):
 *   - conversations.status='pending', bot_silenced_until='infinity'
 *   - crm_lead_activities INSERT (type='handoff_triggered') quando há lead vinculado
 *   - event_log INSERT event_type='ai.handoff_triggered'
 *   - Realtime broadcast `org:<org>:queue` event=handoff_pending
 *   - api_audit_log action='ai.handoff_triggered'
 *   - conversations.assigned_to_user_id round-robin entre membros agent+ ativos
 *
 * Nenhum mirror REST. Wave 4 introduz como tool MCP only.
 */
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

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

const ELIGIBLE_ROLES_BY_MIN: Record<string, string[]> = {
  agent: ["agent", "manager", "admin"],
  manager: ["manager", "admin"],
  admin: ["admin"],
};

async function pickRoundRobinAssignee(
  supabase: SupabaseClient,
  organizationId: string,
  minRole: string,
): Promise<string | null> {
  const eligibleRoles = ELIGIBLE_ROLES_BY_MIN[minRole] ?? ["agent", "manager", "admin"];
  const { data, error } = await supabase
    .from("user_organizations")
    .select("user_id, role")
    .eq("organization_id", organizationId)
    .is("revoked_at", null)
    .in("role", eligibleRoles);

  if (error || !data || data.length === 0) return null;
  const idx = Math.floor(Math.random() * data.length);
  const picked = data[idx] as { user_id: string };
  return picked?.user_id ?? null;
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
      metadata: {
        source: "ai_agent",
        urgency: input.urgency,
        original_reason: input.reason,
        ...(ctx.actor.type === "ai_agent" ? { run_id: ctx.actor.id } : {}),
        ...(input.metadata ?? {}),
      },
    });

    let assignedUserId: string | null = null;
    if (result.triggered) {
      assignedUserId = await pickRoundRobinAssignee(
        ctx.supabase,
        ctx.organizationId,
        input.suggested_assignee_role ?? "agent",
      );
      if (assignedUserId) {
        const { error: assignErr } = await ctx.supabase
          .from("conversations")
          .update({
            assigned_to_user_id: assignedUserId,
            assigned_at: new Date().toISOString(),
          })
          .eq("id", input.conversation_id)
          .eq("organization_id", ctx.organizationId);
        if (assignErr) {
          console.error("[mcp.handoff] assignment failed", assignErr.message);
          assignedUserId = null;
        }
      }
    }

    return {
      handoff_recorded: result.triggered,
      conversation_id: input.conversation_id,
      assigned_to_user_id: assignedUserId,
      idempotent: !result.triggered && result.reason === "idempotent_5s",
      next_action:
        "Avise o cliente em tom acolhedor que um atendente humano vai assumir em instantes.",
    };
  },
};
