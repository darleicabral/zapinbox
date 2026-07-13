/**
 * C4 — Varredura de SLA de atendimento (2 etapas), consumida pelo cron
 * `/api/v1/cron/attendance-sla`. Decisões aprovadas (ESTADO.md):
 *
 *   Etapa 1 (claim): conversa `pending` atribuída e não assumida em
 *     `claim_sla_minutes` → repassa ao próximo do rodízio (online + ponteiro).
 *     Após `max_passes` sem claim → cai pro gestor/admin (fallback) com alerta.
 *     Conversa `pending` SEM dono (ninguém online no handoff) também é tentada
 *     aqui quando alguém fica online.
 *
 *   Etapa 2 (1ª resposta): conversa `claimed` sem resposta humana em
 *     `first_response_sla_minutes` → alerta o gestor (uma vez).
 *
 * Alertas: emit_event no event_log + broadcast realtime em `org:<org>:queue`
 * (mesmo canal que o handoff usa pra acender a UI da fila). Sem tabela de
 * notificações no schema — a UI consome o realtime/event_log.
 *
 * Service-role: filtra `organization_id` em toda query (RLS bypass).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { notifyAssigneeNewLead } from "./notify";
import {
  inBusinessHours,
  loadAttendanceSettings,
  pickFallbackManager,
  pickNextAssignee,
  type AttendanceSettings,
} from "./rotation";

export interface SlaSweepSummary {
  orgs_scanned: number;
  reassigned: number;
  escalated_to_manager: number;
  first_response_alerts: number;
  left_unassigned: number;
  errors: string[];
}

interface PendingConv {
  id: string;
  assigned_to_user_id: string | null;
  assigned_at: string | null;
  status_changed_at: string;
  assignment_passes: number;
}

interface ClaimedConv {
  id: string;
  assigned_to_user_id: string | null;
  status_changed_at: string;
}

function emptySummary(): SlaSweepSummary {
  return {
    orgs_scanned: 0,
    reassigned: 0,
    escalated_to_manager: 0,
    first_response_alerts: 0,
    left_unassigned: 0,
    errors: [],
  };
}

async function emitAlert(
  admin: SupabaseClient,
  organizationId: string,
  eventType: string,
  conversationId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await admin.rpc("emit_event" as never, {
      p_event_type: eventType,
      p_entity_kind: "conversation",
      p_entity_id: conversationId,
      p_payload: { conversation_id: conversationId, ...payload },
      p_metadata: { source: "attendance-sla" },
      p_organization_id: organizationId,
    } as never);
  } catch {
    /* event_log best-effort */
  }
  try {
    const channel = admin.channel(`org:${organizationId}:queue`);
    await channel.send({
      type: "broadcast",
      event: eventType,
      payload: { conversation_id: conversationId, ...payload },
    });
    await admin.removeChannel(channel);
  } catch {
    /* realtime best-effort */
  }
}

async function sweepOrg(
  admin: SupabaseClient,
  settings: AttendanceSettings,
  now: number,
  summary: SlaSweepSummary,
): Promise<void> {
  const orgId = settings.organization_id;
  const claimCutoff = now - settings.claim_sla_minutes * 60_000;
  const respCutoff = now - settings.first_response_sla_minutes * 60_000;

  // ── Etapa 1 — claim SLA ────────────────────────────────────────────────
  const { data: pendingRows } = await admin
    .from("conversations")
    .select("id, assigned_to_user_id, assigned_at, status_changed_at, assignment_passes")
    .eq("organization_id", orgId)
    .eq("status", "pending");

  for (const conv of (pendingRows ?? []) as PendingConv[]) {
    // Relógio da etapa 1: quando foi atribuída (ou, sem dono, quando virou pending).
    const clock = new Date(conv.assigned_at ?? conv.status_changed_at).getTime();
    if (clock > claimCutoff) continue; // ainda dentro do SLA

    const passes = conv.assignment_passes ?? 0;

    if (conv.assigned_to_user_id && passes >= settings.max_passes) {
      // Fallback: gestor/admin. Só escala se ainda não está com um gestor
      // (evita re-alertar em loop a cada tick).
      const manager = await pickFallbackManager(admin, orgId);
      if (!manager || manager === conv.assigned_to_user_id) continue;
      await admin
        .from("conversations")
        .update({ assigned_to_user_id: manager, assigned_at: new Date(now).toISOString() })
        .eq("id", conv.id)
        .eq("organization_id", orgId);
      await emitAlert(admin, orgId, "attendance.escalated_to_manager", conv.id, {
        manager_user_id: manager,
        passes,
      });
      void notifyAssigneeNewLead(admin, {
        organizationId: orgId,
        conversationId: conv.id,
        assigneeUserId: manager,
        kind: "escalated",
      });
      summary.escalated_to_manager += 1;
      continue;
    }

    // Repasse (ou 1ª atribuição de conversa órfã) ao próximo online do rodízio.
    const next = await pickNextAssignee(admin, orgId, {
      excludeUserIds: conv.assigned_to_user_id ? [conv.assigned_to_user_id] : [],
    });
    if (!next) {
      summary.left_unassigned += 1; // ninguém online — tenta no próximo tick
      continue;
    }
    await admin
      .from("conversations")
      .update({
        assigned_to_user_id: next,
        assigned_at: new Date(now).toISOString(),
        assignment_passes: passes + 1,
      })
      .eq("id", conv.id)
      .eq("organization_id", orgId);
    await emitAlert(admin, orgId, "attendance.reassigned", conv.id, {
      to_user_id: next,
      from_user_id: conv.assigned_to_user_id,
      pass: passes + 1,
    });
    void notifyAssigneeNewLead(admin, {
      organizationId: orgId,
      conversationId: conv.id,
      assigneeUserId: next,
      kind: "reassigned",
    });
    summary.reassigned += 1;
  }

  // ── Etapa 2 — 1ª resposta SLA ──────────────────────────────────────────
  const { data: claimedRows } = await admin
    .from("conversations")
    .select("id, assigned_to_user_id, status_changed_at")
    .eq("organization_id", orgId)
    .eq("status", "claimed")
    .is("first_response_alerted_at", null);

  for (const conv of (claimedRows ?? []) as ClaimedConv[]) {
    const claimedAt = new Date(conv.status_changed_at).getTime();
    if (claimedAt > respCutoff) continue;

    // Houve resposta humana após o claim? (bot fica silenciado pós-handoff,
    // então qualquer outbound depois do claim é humano.)
    const { count } = await admin
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("conversation_id", conv.id)
      .eq("direction", "outbound")
      .gt("created_at", conv.status_changed_at);
    if ((count ?? 0) > 0) continue; // já respondeu

    await admin
      .from("conversations")
      .update({ first_response_alerted_at: new Date(now).toISOString() })
      .eq("id", conv.id)
      .eq("organization_id", orgId);
    await emitAlert(admin, orgId, "attendance.first_response_breached", conv.id, {
      assigned_to_user_id: conv.assigned_to_user_id,
      sla_minutes: settings.first_response_sla_minutes,
    });
    // Alerta ativo pro gestor (push + WhatsApp) — o event_log/realtime só
    // aparece pra quem está com o app aberto; o gestor precisa saber fora dele.
    const manager = await pickFallbackManager(admin, orgId);
    if (manager && manager !== conv.assigned_to_user_id) {
      void notifyAssigneeNewLead(admin, {
        organizationId: orgId,
        conversationId: conv.id,
        assigneeUserId: manager,
        kind: "sla_alert",
      });
    }
    summary.first_response_alerts += 1;
  }
}

export async function sweepAttendanceSla(
  admin: SupabaseClient,
  opts: { now?: Date } = {},
): Promise<SlaSweepSummary> {
  const summary = emptySummary();
  const now = (opts.now ?? new Date()).getTime();

  const { data: enabledOrgs, error } = await admin
    .from("attendance_settings")
    .select("organization_id")
    .eq("enabled", true);
  if (error) {
    summary.errors.push(`load_settings: ${error.message}`);
    return summary;
  }

  for (const row of (enabledOrgs ?? []) as { organization_id: string }[]) {
    const settings = await loadAttendanceSettings(admin, row.organization_id);
    if (!settings || !settings.enabled) continue;
    // Fora do expediente o tick pula a org: nada repassa/escala/alerta de
    // madrugada; o próximo tick dentro da janela retoma de onde parou.
    if (!inBusinessHours(settings.business_hours, new Date(now))) continue;
    summary.orgs_scanned += 1;
    try {
      await sweepOrg(admin, settings, now, summary);
    } catch (err) {
      summary.errors.push(`${row.organization_id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return summary;
}
