/**
 * C1 — Follow-up por inatividade (cadência de reengajamento), consumido pelo
 * cron `/api/v1/cron/inactivity-followup`.
 *
 * Regras (cadencia-reengajamento.md da Avant):
 *  - Só roda com o BOT ainda no comando (conversa 'open'/'ai_handling', não
 *    silenciada). Transferida pra equipe ("Só um momento") → não roda.
 *  - Lead responde → a próxima entrada resetá `followup_step` (last_inbound_at
 *    passa a ser > last_followup_at) e a cadência recomeça.
 *  - Etapas por tenant (`followup_settings.steps`): cada uma dispara quando a
 *    inatividade (agora − last_inbound_at) cruza `after_minutes`. Etapa com
 *    `discard:true` encerra: move o lead pra "perdido" e resolve a conversa.
 *  - Respeita expediente, opt-out (contato bloqueado por STOP) e throttle.
 *
 * Service-role: filtra organization_id em toda query.
 */
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { inBusinessHours, type BusinessHours } from "@/lib/attendance/rotation";
import { logger } from "@/lib/logger";

export interface FollowupStep {
  after_minutes: number;
  message: string;
  discard?: boolean;
}

interface FollowupSettings {
  organization_id: string;
  enabled: boolean;
  throttle_seconds: number;
  business_hours: BusinessHours | null;
  steps: FollowupStep[];
}

export interface FollowupSweepSummary {
  orgs_scanned: number;
  sent: number;
  discarded: number;
  reset: number;
  errors: string[];
}

interface ConvRow {
  id: string;
  contact_id: string | null;
  status: string;
  last_inbound_at: string | null;
  last_followup_at: string | null;
  followup_step: number;
  bot_silenced_until: string | null;
  contacts: { display_name: string | null; is_blocked: boolean; force_human: boolean } | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function firstName(displayName: string | null): string {
  const n = (displayName ?? "").trim().split(/\s+/)[0] ?? "";
  return n.length >= 2 ? n : "tudo bem";
}

/** Move o lead do contato pra etapa "perdido" (descarte por inatividade). */
async function discardLead(
  admin: SupabaseClient,
  orgId: string,
  contactId: string,
): Promise<void> {
  const { data: lead } = await admin
    .from("crm_leads")
    .select("id, pipeline_id, status")
    .eq("organization_id", orgId)
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!lead || (lead as { status: string }).status !== "open") return;

  const pipelineId = (lead as { pipeline_id: string }).pipeline_id;
  const { data: lostStage } = await admin
    .from("crm_stages")
    .select("id")
    .eq("organization_id", orgId)
    .eq("pipeline_id", pipelineId)
    .eq("is_lost", true)
    .eq("is_archived", false)
    .order("position", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!lostStage) return;

  await admin
    .from("crm_leads")
    .update({
      stage_id: (lostStage as { id: string }).id,
      status: "lost",
      lost_reason: "Inatividade (cadência de reengajamento)",
      closed_at: new Date().toISOString(),
    })
    .eq("id", (lead as { id: string }).id)
    .eq("organization_id", orgId);
}

async function sweepOrg(
  admin: SupabaseClient,
  settings: FollowupSettings,
  now: number,
  summary: FollowupSweepSummary,
): Promise<void> {
  const orgId = settings.organization_id;
  const steps = settings.steps;
  if (!Array.isArray(steps) || steps.length === 0) return;
  if (!inBusinessHours(settings.business_hours, new Date(now))) return; // fora do expediente

  const { data: rows } = await admin
    .from("conversations")
    .select(
      "id, contact_id, status, last_inbound_at, last_followup_at, followup_step, bot_silenced_until, contacts:contact_id(display_name, is_blocked, force_human)",
    )
    .eq("organization_id", orgId)
    .in("status", ["open", "ai_handling"])
    .not("last_inbound_at", "is", null);

  for (const conv of (rows ?? []) as unknown as ConvRow[]) {
    if (!conv.contacts || conv.contacts.is_blocked || conv.contacts.force_human) continue;
    // Transferida pra humano (silenciada) → cadência não roda.
    if (conv.bot_silenced_until && new Date(conv.bot_silenced_until).getTime() > now) continue;

    const lastInbound = new Date(conv.last_inbound_at!).getTime();

    // Lead respondeu depois do nosso último follow-up → reseta a cadência.
    if (conv.followup_step > 0 && conv.last_followup_at) {
      if (lastInbound > new Date(conv.last_followup_at).getTime()) {
        await admin
          .from("conversations")
          .update({ followup_step: 0, last_followup_at: null })
          .eq("id", conv.id)
          .eq("organization_id", orgId);
        summary.reset += 1;
        continue;
      }
    }

    if (conv.followup_step >= steps.length) continue;
    const step = steps[conv.followup_step]!;
    const inactivityMin = (now - lastInbound) / 60_000;
    if (inactivityMin < step.after_minutes) continue; // ainda dentro do prazo

    // Envia a mensagem da etapa (persiste + WAHA via sendMessageHandler).
    const body = step.message.replace(/\{nome\}/g, firstName(conv.contacts.display_name));
    try {
      await sendMessageHandler(
        admin,
        {
          organization_id: orgId,
          actor: { type: "ai_agent", id: "followup-worker", role: "agent" },
          requestId: randomUUID(),
        },
        { conversation_id: conv.id, type: "text", body },
      );
    } catch (err) {
      summary.errors.push(`${conv.id}: send ${err instanceof Error ? err.message : String(err)}`);
      continue; // não avança a etapa se o envio falhou
    }

    await admin
      .from("conversations")
      .update({
        followup_step: conv.followup_step + 1,
        last_followup_at: new Date(now).toISOString(),
        ...(step.discard ? { status: "resolved", status_changed_at: new Date(now).toISOString() } : {}),
      })
      .eq("id", conv.id)
      .eq("organization_id", orgId);

    await admin.rpc("emit_event" as never, {
      p_event_type: "followup.sent",
      p_entity_kind: "conversation",
      p_entity_id: conv.id,
      p_payload: { conversation_id: conv.id, step: conv.followup_step + 1, discard: !!step.discard },
      p_metadata: { source: "inactivity-followup" },
      p_organization_id: orgId,
    } as never);

    if (step.discard && conv.contact_id) {
      await discardLead(admin, orgId, conv.contact_id);
      summary.discarded += 1;
    }
    summary.sent += 1;

    if (settings.throttle_seconds > 0) await sleep(settings.throttle_seconds * 1000);
  }
}

export async function sweepFollowups(
  admin: SupabaseClient,
  opts: { now?: Date } = {},
): Promise<FollowupSweepSummary> {
  const summary: FollowupSweepSummary = {
    orgs_scanned: 0,
    sent: 0,
    discarded: 0,
    reset: 0,
    errors: [],
  };
  const now = (opts.now ?? new Date()).getTime();

  const { data: enabledOrgs, error } = await admin
    .from("followup_settings")
    .select("organization_id, enabled, throttle_seconds, business_hours, steps")
    .eq("enabled", true);
  if (error) {
    summary.errors.push(`load_settings: ${error.message}`);
    return summary;
  }

  for (const s of (enabledOrgs ?? []) as unknown as FollowupSettings[]) {
    if (!s.enabled) continue;
    summary.orgs_scanned += 1;
    try {
      await sweepOrg(admin, s, now, summary);
    } catch (err) {
      summary.errors.push(`${s.organization_id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return summary;
}
