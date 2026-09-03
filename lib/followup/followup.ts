/**
 * C1 — Follow-up por inatividade (cadência de reengajamento), consumido pelo
 * cron `/api/v1/cron/inactivity-followup`.
 *
 * Regras (cadencia-reengajamento.md da Avant):
 *  - Só roda com o BOT ainda no comando (conversa 'open'/'ai_handling', não
 *    silenciada). Transferida pra equipe ("Só um momento") → não roda.
 *  - PARA quando um corretor já foi avisado (conversa com `assigned_to_user_id`):
 *    o aviso vai pro WhatsApp pessoal dele e ele continua o atendimento do
 *    próprio número, então cutucar o lead só atrapalha. Atribuído e esquecido é
 *    problema do SLA (lib/attendance/sla.ts), não do reengajamento.
 *  - PARA quando um humano respondeu depois da última mensagem do lead (corretor
 *    que digita direto, sem passar o bastão pelo bot).
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
  /** Dono da conversa. Preenchido = corretor já foi avisado, cadência para. */
  assigned_to_user_id: string | null;
  contacts: { display_name: string | null; is_blocked: boolean; force_human: boolean } | null;
}

/**
 * Idade máxima da última mensagem do lead pra a cadência COMEÇAR.
 *
 * Existe por causa do incidente de 03/09/2026: ligar o reengajamento sobre o
 * acervo mandou 116 mensagens pra 34 conversas em 5 minutos, porque conversa
 * parada há horas já cruzou o prazo de todas as etapas. "Oi, ainda tá por aí?"
 * só faz sentido minutos depois do lead sumir, não dias. Em operação normal isto
 * nunca pega: a cadência começa poucos minutos depois do silêncio.
 */
const MAX_IDADE_PARA_INICIAR_MIN = 180;

/**
 * A etapa `indice` pode disparar agora? Pura, pra ser testável sem banco.
 *
 * Duas regras nasceram do incidente de 03/09/2026 (116 mensagens em 34 conversas
 * em 5 minutos ao ligar a cadência sobre o acervo):
 *
 *  1. `after_minutes` sozinho não basta. Ele mede o silêncio DO LEAD, e lead
 *     parado há dias tem TODAS as etapas vencidas ao mesmo tempo — cada passada
 *     do cron mandava a próxima, e a cadência inteira saía em minutos. Daí o
 *     INTERVALO entre a etapa anterior e esta ter de ter passado desde o nosso
 *     último envio.
 *  2. Cadência não ressuscita conversa velha: só COMEÇA (etapa 0) se o lead
 *     falou há menos de `maxIdadeParaIniciarMin`. Cadência em andamento segue,
 *     senão a última etapa (24h) nunca aconteceria.
 */
export function podeDisparar(
  steps: FollowupStep[],
  indice: number,
  ctx: {
    inactivityMin: number;
    /** minutos desde o NOSSO último follow-up; null se nunca mandamos */
    desdeUltimoFollowupMin: number | null;
    maxIdadeParaIniciarMin?: number;
  },
): boolean {
  const step = steps[indice];
  if (!step) return false;
  if (ctx.inactivityMin < step.after_minutes) return false;

  const maxIdade = ctx.maxIdadeParaIniciarMin ?? MAX_IDADE_PARA_INICIAR_MIN;
  if (indice === 0) return ctx.inactivityMin <= maxIdade;

  if (ctx.desdeUltimoFollowupMin == null) return true;
  const anterior = steps[indice - 1]!;
  const intervaloMin = Math.max(step.after_minutes - anterior.after_minutes, 0);
  return ctx.desdeUltimoFollowupMin >= intervaloMin;
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
      "id, contact_id, status, last_inbound_at, last_followup_at, followup_step, bot_silenced_until, assigned_to_user_id, contacts:contact_id(display_name, is_blocked, force_human)",
    )
    .eq("organization_id", orgId)
    .in("status", ["open", "ai_handling"])
    .not("last_inbound_at", "is", null);

  for (const conv of (rows ?? []) as unknown as ConvRow[]) {
    if (!conv.contacts || conv.contacts.is_blocked || conv.contacts.force_human) continue;
    // Transferida pra humano (silenciada) → cadência não roda.
    // ⚠️ O handoff grava bot_silenced_until='infinity' (EPIC-06/IA-06). O
    // PostgREST serializa timestamptz 'infinity' como a STRING "infinity", que
    // new Date() parseia como NaN — e `NaN > now` é false, então o check antigo
    // NÃO pegava o handoff e o follow-up cutucava conversa já entregue a humano.
    // Mesmo tratamento explícito que o dispatcher já faz (dispatcher/index.ts:226).
    const silencedUntil = conv.bot_silenced_until;
    if (
      silencedUntil &&
      (silencedUntil === "infinity" || new Date(silencedUntil).getTime() > now)
    ) {
      continue;
    }

    // Corretor já foi avisado → cadência PARA. Decisão do Darlei (03/09/2026):
    // o aviso sai no WhatsApp pessoal do corretor e ele continua o atendimento
    // do próprio número, então de nada serve o sistema seguir cutucando o lead.
    // A atribuição é exatamente o que dispara a notificação (lib/attendance/
    // assign.ts), por isso ela é o sinal. Lead atribuído e esquecido não fica
    // órfão: quem cobra é o SLA (lib/attendance/sla.ts), que reescala e, no teto
    // de passes, chama o gestor. Não é papel do reengajamento.
    if (conv.assigned_to_user_id) continue;

    const lastInbound = new Date(conv.last_inbound_at!).getTime();

    // Humano já respondeu depois da última mensagem do lead → NÃO cutucar.
    // Foi a causa do incidente 01/09: `bot_silenced_until` só é preenchido pela
    // tool de handoff do bot, então corretor que atende direto (pelo celular ou
    // pelo composer, sem o bot passar o bastão) não silenciava a cadência, e o
    // lead levava ping durante a negociação. Agora que o eco do WAHA é
    // descartado no ingest, `user`/`external_device` significam humano DE VERDADE,
    // então esta checagem é confiável. `sent_via='ai'` fica de fora de propósito
    // (é o próprio bot/follow-up, não conta como atendimento humano).
    const { data: humanReply } = await admin
      .from("messages")
      .select("id")
      .eq("organization_id", orgId)
      .eq("conversation_id", conv.id)
      .eq("direction", "outbound")
      .in("sent_via", ["user", "external_device"])
      .gt("sent_at", conv.last_inbound_at!)
      .limit(1)
      .maybeSingle();
    if (humanReply) continue;

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

    // Trava de idade (não ressuscitar conversa velha) + espaçamento entre etapas.
    // As duas nasceram do incidente de 03/09/2026 — ver podeDisparar().
    const desdeUltimoFollowupMin = conv.last_followup_at
      ? (now - new Date(conv.last_followup_at).getTime()) / 60_000
      : null;
    if (!podeDisparar(steps, conv.followup_step, { inactivityMin, desdeUltimoFollowupMin })) continue;

    // ⚠️ RESERVA A ETAPA ANTES DE ENVIAR (mesmo incidente: a Norma recebeu a
    // MESMA frase 3x em 35s). Antes o código enviava e só depois avançava, então
    // duas passadas concorrentes do cron liam o mesmo followup_step e as duas
    // enviavam. O update condicional em followup_step é a reserva: quem não
    // atualizar nenhuma linha perdeu a corrida e não envia.
    const { data: reservou } = await admin
      .from("conversations")
      .update({
        followup_step: conv.followup_step + 1,
        last_followup_at: new Date(now).toISOString(),
        ...(step.discard ? { status: "resolved", status_changed_at: new Date(now).toISOString() } : {}),
      })
      .eq("id", conv.id)
      .eq("organization_id", orgId)
      .eq("followup_step", conv.followup_step)
      .select("id");
    if (!reservou || reservou.length === 0) continue; // outra passada já pegou

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
      // Devolve a etapa: com a reserva feita antes do envio, falhar aqui sem
      // desfazer pularia a etapa pra sempre. Preferimos tentar de novo na
      // próxima passada a perder o toque — e mandar 2x é pior que mandar tarde,
      // por isso a reserva vem antes mesmo assim.
      await admin
        .from("conversations")
        .update({ followup_step: conv.followup_step, last_followup_at: conv.last_followup_at })
        .eq("id", conv.id)
        .eq("organization_id", orgId);
      continue;
    }

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
