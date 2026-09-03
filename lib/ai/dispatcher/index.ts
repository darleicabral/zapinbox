/**
 * `agent-dispatcher` worker (S-13.07, Spec 10 §5).
 *
 * Pulls `ai_agent.dispatch_requested` rows from `event_log`, picks the
 * top-priority published agent for the (org, channel_session) tuple that
 * matches the inbound message, and creates an `ai_agent_runs` row + a
 * fire-and-forget POST to `/api/internal/agents/run`.
 *
 * Service-role caveat (CLAUDE.md §multi-tenancy): admin client bypasses RLS.
 * Every query in this module filters `organization_id` from the trusted event
 * payload, never user input.
 *
 * Schema mapping note: the spec talks about `processed_at`, but `event_log`
 * uses `status` + `consumed_by[]`. We mark a successfully-handled event as
 * `status='done'` and stamp `metadata.outcome`. Requeue (rate-limit) sets
 * `next_attempt_at = now()+5s` and keeps `status='pending'` so the next batch
 * picks it up. NOTE: the CHECK constraint only allows
 * pending|processing|done|dead — 'processed'/'failed' (usados numa versão
 * anterior deste arquivo) violavam o constraint e deixavam eventos presos em
 * 'processing' pra sempre.
 */

import { randomUUID } from "node:crypto";

import { createAdminClient } from "@/lib/supabase/admin";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { checkTenantBudget } from "./budget";
import { checkRateLimit } from "./rate-limit";
import {
  triggerMatches,
  type TriggerConfig,
  type DispatchMessage,
  type DispatchConversation,
} from "./triggers";

export const DISPATCHER_KEY = "worker.agent-dispatcher.v1";
export const DISPATCH_EVENT_TYPE = "ai_agent.dispatch_requested";

const DEFAULT_BATCH_SIZE = 100;
// Janela em que a última fala humana ainda significa "o corretor está no comando".
// 60min é folgado perto do SLA da casa (assumir em 5min, 1a resposta em 10min).
const HUMAN_ACTIVE_WINDOW_MIN = 60;
const RATE_LIMIT_PER_MIN = 60;
const RATE_LIMIT_WINDOW_SEC = 60;
const REQUEUE_DELAY_MS = 5_000;
// Quantas vezes reenfileirar quando a conversa tem run em voo. 5 × 5s = 25s,
// folgado pro run normal (poucos segundos) e curto o bastante pra run travado
// não reenfileirar pra sempre.
const CONV_BUSY_MAX_ATTEMPTS = 5;
// Run em voo mais velho que isto é considerado MORTO, não ocupado. Existe porque
// o banco acumula 'pending' órfão quando o POST pro runner falha (56 deles em
// 03/09/2026, um de 51 dias). Sem a janela, resíduo silencia a conversa.
const RUN_INFLIGHT_WINDOW_MIN = 5;

/**
 * O corretor humano está no comando desta conversa?
 *
 * Recebe a ÚLTIMA mensagem de saída da conversa. Se ela é humana e recente, o
 * bot não responde por cima. Pura de propósito, pra ser testável sem banco.
 *
 * `sent_via`: 'ai' é o próprio bot/follow-up; 'user' é humano pelo composer do
 * CRM; 'external_device' é humano pelo celular. Desde e38639e o eco do WAHA é
 * descartado no ingest, então 'external_device' significa humano DE VERDADE e
 * esta checagem é confiável.
 *
 * Devolve null quando o bot pode seguir, ou os dados do bloqueio pra auditoria.
 */
export function humanIsHandling(
  ultimaSaida: { sent_via: string | null; sent_at: string | null } | null,
  agoraMs: number,
): { via: string; minutosAtras: number } | null {
  if (!ultimaSaida) return null;
  const via = ultimaSaida.sent_via ?? "";
  if (via !== "user" && via !== "external_device") return null; // bot falou por último
  if (!ultimaSaida.sent_at) return null;
  const minutosAtras = (agoraMs - new Date(ultimaSaida.sent_at).getTime()) / 60_000;
  if (minutosAtras >= HUMAN_ACTIVE_WINDOW_MIN) return null; // humano respondeu e sumiu
  return { via, minutosAtras: Math.round(minutosAtras) };
}

export type DispatchOutcome =
  | "dispatched"
  | "no_match"
  | "conv_busy"
  | "budget_exceeded"
  | "rate_limited"
  | "skipped_invalid_payload"
  | "skipped_missing_message"
  | "skipped_silenced"
  | "skipped_human_active"
  | "error";

export interface DispatchSummary {
  batch_size: number;
  outcomes: Record<DispatchOutcome, number>;
  errors: string[];
}

interface EventRow {
  id: string;
  organization_id: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown> | null;
  consumed_by: string[];
  attempts: number;
}

interface CandidateRow {
  id: string;
  priority: number;
  created_at: string;
  archived_at: string | null;
  organization_id: string;
  published_version_id: string | null;
  version: VersionRow | null;
}

interface VersionRow {
  id: string;
  organization_id: string;
  status: string;
  channel_session_id: string;
  trigger_config: TriggerConfig;
}

const EMPTY_OUTCOMES = (): Record<DispatchOutcome, number> => ({
  dispatched: 0,
  no_match: 0,
  conv_busy: 0,
  budget_exceeded: 0,
  rate_limited: 0,
  skipped_invalid_payload: 0,
  skipped_missing_message: 0,
  skipped_silenced: 0,
  skipped_human_active: 0,
  error: 0,
});

export interface DispatchOptions {
  /** Max events to claim in a single run (default 100, Spec 10 §5.2). */
  batchSize?: number;
  /** Override clock (tests). */
  now?: Date;
}

export async function dispatchAgents(opts: DispatchOptions = {}): Promise<DispatchSummary> {
  const admin = createAdminClient();
  const batchSize = Math.min(Math.max(opts.batchSize ?? DEFAULT_BATCH_SIZE, 1), 500);
  const summary: DispatchSummary = {
    batch_size: 0,
    outcomes: EMPTY_OUTCOMES(),
    errors: [],
  };

  // 1. Pull pending dispatch_requested events that are due (next_attempt_at
  //    null or past). Order by created_at to keep FIFO semantics.
  const nowIso = (opts.now ?? new Date()).toISOString();
  const { data: rawEvents, error: pullErr } = await admin
    .from("event_log")
    .select("id, organization_id, payload, metadata, consumed_by, attempts, next_attempt_at, status")
    .eq("event_type", DISPATCH_EVENT_TYPE)
    .eq("status", "pending")
    .or(`next_attempt_at.is.null,next_attempt_at.lte.${nowIso}`)
    .order("created_at", { ascending: true })
    .limit(batchSize);

  if (pullErr) {
    summary.errors.push(`event_log_pull_failed: ${pullErr.message}`);
    return summary;
  }

  const candidateEvents = (rawEvents ?? []) as EventRow[];
  if (candidateEvents.length === 0) return summary;

  // 1.5. Mata run MORTO antes de decidir qualquer coisa.
  //
  // O POST pro runner é fire-and-forget: se ele falha, a linha fica em 'pending'
  // pra sempre. Em 03/09/2026 havia 56 dessas, a mais antiga de 13/07 (51 dias),
  // e 12 conversas com mais de uma. Isso quebrava a trava de concorrência nos
  // dois sentidos: run órfão não impedia resposta dupla (o índice cobria só
  // 'running') e, com a trava nova, passaria a silenciar a conversa pra sempre.
  // Limpar aqui resolve o acervo sozinho e mantém a trava confiável sem depender
  // de limpeza manual nem de índice único, que com resíduo vira mordaça.
  await abortStaleRuns();

  // 2. Claim each event optimistically (CAS on status='pending'). Skip when
  //    another worker already processed/claimed it in this tick.
  for (const event of candidateEvents) {
    const claimed = await claimEvent(event.id);
    if (!claimed) continue;
    summary.batch_size += 1;

    try {
      const outcome = await processEvent(event);
      summary.outcomes[outcome] += 1;
    } catch (err) {
      summary.outcomes.error += 1;
      const detail = err instanceof Error ? err.message : String(err);
      summary.errors.push(`${event.id}:${detail}`);
      logger.error("[agent-dispatcher] processEvent threw", {
        event_id: event.id,
        organization_id: event.organization_id,
        error: detail,
      });
      await markEventFailed(event, detail);
    }
  }

  return summary;
}

/**
 * Marca como 'aborted' os runs em voo que passaram da janela. Sem isto o banco
 * acumula 'pending' órfão (POST pro runner falhou) e a trava de concorrência
 * fica furada ou vira mordaça — ver a nota no passo 1.5.
 */
async function abortStaleRuns(): Promise<void> {
  const admin = createAdminClient();
  const limite = new Date(Date.now() - RUN_INFLIGHT_WINDOW_MIN * 60_000).toISOString();
  const { data, error } = await admin
    .from("ai_agent_runs")
    .update({
      status: "aborted",
      abort_reason: "stale_inflight",
      completed_at: new Date().toISOString(),
    })
    .in("status", ["pending", "running"])
    .eq("is_dry_run", false)
    .lt("created_at", limite)
    .select("id");
  if (error) {
    logger.warn("[agent-dispatcher] abortStaleRuns falhou", { error: error.message });
    return;
  }
  if (data && data.length > 0) {
    logger.warn("[agent-dispatcher] runs órfãos abortados", { count: data.length });
  }
}

// ---------------------------------------------------------------------------
// Per-event pipeline
// ---------------------------------------------------------------------------

async function processEvent(event: EventRow): Promise<DispatchOutcome> {
  const admin = createAdminClient();

  const payload = event.payload ?? {};
  const orgId = String(payload.organization_id ?? event.organization_id);
  const conversationId = strOrNull(payload.conversation_id);
  const channelSessionId = strOrNull(payload.channel_session_id);
  const inboundMessageId = strOrNull(payload.inbound_message_id);

  if (!orgId || !conversationId || !channelSessionId || !inboundMessageId) {
    await markEventProcessed(event, "skipped_invalid_payload");
    return "skipped_invalid_payload";
  }

  // Org from payload must match the row's organization_id (defence-in-depth).
  if (orgId !== event.organization_id) {
    await markEventProcessed(event, "skipped_invalid_payload", {
      reason: "org_mismatch",
    });
    return "skipped_invalid_payload";
  }

  // Load the inbound message + conversation. Both filtered by org.
  const { data: messageRow } = await admin
    .from("messages")
    .select("id, body, direction, created_at, contact_id, conversation_id, organization_id")
    .eq("id", inboundMessageId)
    .eq("organization_id", orgId)
    .maybeSingle();

  if (!messageRow) {
    await markEventProcessed(event, "skipped_missing_message");
    return "skipped_missing_message";
  }

  const message: DispatchMessage = {
    id: messageRow.id as string,
    body: (messageRow.body as string | null) ?? null,
    direction: messageRow.direction as string,
    created_at: messageRow.created_at as string,
  };

  const { data: convRow } = await admin
    .from("conversations")
    .select("id, organization_id, is_group, group_chat_id, bot_silenced_until")
    .eq("id", conversationId)
    .eq("organization_id", orgId)
    .maybeSingle();

  if (!convRow) {
    await markEventProcessed(event, "skipped_missing_message", { reason: "conv_missing" });
    return "skipped_missing_message";
  }

  // Pós-handoff o bot fica mudo: bot_silenced_until='infinity' (EPIC-06/IA-06).
  // Sem este check o dispatcher responderia por cima do humano que assumiu.
  // Atenção: PostgREST serializa timestamptz 'infinity' como a string
  // "infinity", que NÃO parseia via new Date() — trate explicitamente.
  const silencedUntil = convRow.bot_silenced_until as string | null;
  const isSilenced =
    !!silencedUntil &&
    (silencedUntil === "infinity" || new Date(silencedUntil).getTime() > Date.now());
  if (isSilenced) {
    await markEventProcessed(event, "skipped_silenced");
    return "skipped_silenced";
  }

  // Corretor humano no comando → o bot não responde por cima.
  //
  // `bot_silenced_until` só é preenchido pela tool de handoff. Corretor que
  // simplesmente começa a digitar (pelo composer ou pelo celular) não silencia
  // nada, e o bot entrava no meio da conversa. Medido em produção 03/09/2026:
  // conversa 3456e9ba, Robson respondendo à mão 13:07:09 e 13:07:21, e o bot
  // cortando 13:07:58 com "Olá! Tudo bem? 😊 Aqui é o consultor da Avant".
  // Mesma família do incidente do follow-up de 01/09 (lib/followup/followup.ts).
  //
  // Regra: se a ÚLTIMA saída da conversa é humana e recente, o humano é o dono.
  // Olhar "quem falou por último" e não "humano falou depois do lead" é de
  // propósito: o despachante roda POR CAUSA de uma mensagem que acabou de
  // chegar, então comparar com last_inbound_at nunca pegaria nada.
  // A janela deixa a regra se curar sozinha (corretor que respondeu e sumiu não
  // congela a conversa pra sempre) e não briga com o botão "devolver ao bot",
  // que zera o bot_silenced_until sem stampar timestamp nenhum.
  const { data: ultimaSaida } = await admin
    .from("messages")
    .select("sent_via, sent_at")
    .eq("organization_id", orgId)
    .eq("conversation_id", conversationId)
    .eq("direction", "outbound")
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const humanoNoComando = humanIsHandling(
    ultimaSaida as { sent_via: string | null; sent_at: string | null } | null,
    Date.now(),
  );
  if (humanoNoComando) {
    await markEventProcessed(event, "skipped_human_active", {
      last_outbound_via: humanoNoComando.via,
      minutes_ago: humanoNoComando.minutosAtras,
    });
    return "skipped_human_active";
  }

  const conversation: DispatchConversation = {
    id: convRow.id as string,
    is_group: (convRow.is_group as boolean | null) ?? null,
    group_chat_id: (convRow.group_chat_id as string | null) ?? null,
  };

  // Candidate agents: published, non-archived, version bound to this channel session.
  const candidates = await loadCandidates(orgId, channelSessionId);

  // Filter by trigger_config; first match wins (sort already applied).
  const matched = candidates.find((c) =>
    c.version
      ? triggerMatches({
          config: c.version.trigger_config,
          message,
          conversation,
        })
      : false,
  );

  if (!matched || !matched.version) {
    await markEventProcessed(event, "no_match");
    return "no_match";
  }

  // Concurrency pre-check: já existe run EM VOO (pending ou running) nesta
  // conversa? Cobria só 'running', mas o insert abaixo é 'pending': dois
  // despachos no mesmo tique passavam os dois. Medido em 03/09/2026 na conversa
  // bb7cd91b — o lead mandou 2 mensagens no mesmo segundo e o bot deu a abertura
  // completa DUAS vezes, porque nenhum run viu a resposta do outro.
  // ⚠️ Só conta run em voo RECENTE. Em 03/09/2026 o banco tinha 56 runs presos em
  // 'pending' — o mais antigo de 13/07, 51 dias — porque o POST fire-and-forget
  // pro runner pode falhar e ninguém limpa a linha. Sem esta janela, a trava
  // nova silenciaria o bot PARA SEMPRE nessas conversas. Resíduo não pode virar
  // mordaça: run que não terminou em RUN_INFLIGHT_WINDOW_MIN está morto, não
  // ocupado.
  const desdeIso = new Date(Date.now() - RUN_INFLIGHT_WINDOW_MIN * 60_000).toISOString();
  const { data: emVoo } = await admin
    .from("ai_agent_runs")
    .select("id")
    .eq("organization_id", orgId)
    .eq("conversation_id", conversationId)
    .in("status", ["pending", "running"])
    .eq("is_dry_run", false)
    .gte("created_at", desdeIso)
    .limit(1)
    .maybeSingle();

  if (emVoo) {
    // REENFILEIRA em vez de descartar: a 2ª mensagem do lead não pode ser
    // perdida. Ela roda depois que o 1º run terminar, e aí o modelo vê a
    // resposta anterior no histórico e não repete a abertura.
    // Teto de tentativas pra run travado não gerar reenfileiramento eterno.
    if ((event.attempts ?? 0) < CONV_BUSY_MAX_ATTEMPTS) {
      await requeueEvent(event, REQUEUE_DELAY_MS, { reason: "conv_busy", run_in_flight: true });
    } else {
      await markEventProcessed(event, "conv_busy", { reason: "max_attempts", attempts: event.attempts });
    }
    return "conv_busy";
  }

  // Tenant budget guard.
  const budget = await checkTenantBudget(orgId);
  if (!budget.ok) {
    await markEventProcessed(event, "budget_exceeded", {
      is_throttled: budget.is_throttled,
      is_disabled: budget.is_disabled,
      monthly_limit_cents: budget.monthly_limit_cents,
      consumed_cents: budget.current_month_consumed_cents,
    });
    logger.warn("[agent-dispatcher] ai_budget_exceeded", {
      organization_id: orgId,
      event_id: event.id,
      monthly_limit_cents: budget.monthly_limit_cents,
      consumed_cents: budget.current_month_consumed_cents,
    });
    return "budget_exceeded";
  }

  // Per-tenant rate limit (60/min default). Failed limit → requeue, not drop.
  const rateResult = await checkRateLimit(`ai-runs:${orgId}`, RATE_LIMIT_PER_MIN, RATE_LIMIT_WINDOW_SEC);
  if (!rateResult.allowed) {
    await requeueEvent(event, REQUEUE_DELAY_MS, {
      reason: "rate_limited",
      count: rateResult.count,
      limit: rateResult.limit,
    });
    return "rate_limited";
  }

  // Insert run row. O índice único parcial cobre status IN ('pending','running')
  // desde a migration 0031, então corrida entre dois despachantes colide aqui e
  // sai como conv_busy (reenfileirado). Antes o índice cobria só 'running' e a
  // corrida passava, gerando resposta dupla.
  const runId = randomUUID();
  const { error: insertErr } = await admin.from("ai_agent_runs").insert({
    id: runId,
    organization_id: orgId,
    agent_id: matched.id,
    agent_version_id: matched.version.id,
    conversation_id: conversationId,
    contact_id: (messageRow.contact_id as string | null) ?? null,
    channel_session_id: channelSessionId,
    inbound_message_id: inboundMessageId,
    status: "pending",
    is_dry_run: false,
  });

  if (insertErr) {
    if (insertErr.code === "23505") {
      await markEventProcessed(event, "conv_busy", { reason: "unique_index_race" });
      return "conv_busy";
    }
    throw new Error(`ai_agent_runs_insert_failed: ${insertErr.message}`);
  }

  // Fire-and-forget the runner. Failure to reach the runner does not roll
  // back the run row — the runtime cron will retry stuck pending runs.
  await invokeRunner(runId);

  await markEventProcessed(event, "dispatched", {
    run_id: runId,
    agent_id: matched.id,
    agent_version_id: matched.version.id,
  });
  return "dispatched";
}

// ---------------------------------------------------------------------------
// Candidate loading
// ---------------------------------------------------------------------------

/** Exportada só pro teste de regressão do `is_active` (tests/unit/dispatcher-agente-inativo.test.ts). */
export async function loadCandidates(
  orgId: string,
  channelSessionId: string,
): Promise<CandidateRow[]> {
  const admin = createAdminClient();

  // `is_active` é o botão "Ativo" da tela de Agentes. Ele NÃO era checado aqui:
  // desativar o agente na interface não desligava o bot, porque só o
  // workers/ai-response-worker.ts (caminho legado) respeitava o campo, e quem
  // decide de verdade é este despachante. Pior, a tool crm_search_knowledge
  // resolve a KB com `.eq("is_active", true)`, então um agente desativado que
  // fosse despachado responderia SEM base de conhecimento — falando no escuro em
  // vez de calar. Quem desliga o agente espera que ele pare, não que ele piore.
  //
  // Two-step join — supabase-js inner joins on FK aliases work, but the
  // database.types.ts has not been regenerated for the new ai_agents columns
  // yet, so we cast the response shape and filter by channel_session_id in
  // memory after loading published versions. Cheap because we limit the
  // candidate set to published agents per org (small N in MVP).
  const { data, error } = await admin
    .from("ai_agents")
    .select(
      "id, organization_id, priority, created_at, archived_at, published_version_id, version:ai_agent_versions!ai_agents_published_version_id_fkey(id, organization_id, status, channel_session_id, trigger_config)",
    )
    .eq("organization_id", orgId)
    .eq("is_active", true)
    .is("archived_at", null)
    .not("published_version_id", "is", null)
    .order("priority", { ascending: false })
    .order("created_at", { ascending: true });

  if (error) {
    logger.warn("[agent-dispatcher] loadCandidates failed", { error: error.message, organization_id: orgId });
    return [];
  }

  const rows = (data ?? []) as unknown as Array<
    Omit<CandidateRow, "version"> & { version: VersionRow | VersionRow[] | null }
  >;

  return rows
    .map((r) => {
      const version = Array.isArray(r.version) ? r.version[0] ?? null : r.version;
      return { ...r, version } as CandidateRow;
    })
    .filter((r) => r.version && r.version.channel_session_id === channelSessionId);
}

// ---------------------------------------------------------------------------
// Event lifecycle helpers
// ---------------------------------------------------------------------------

async function claimEvent(eventId: string): Promise<boolean> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("event_log")
    .update({ status: "processing", updated_at: new Date().toISOString() })
    .eq("id", eventId)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();
  if (error) {
    logger.warn("[agent-dispatcher] claim failed", { event_id: eventId, error: error.message });
    return false;
  }
  return Boolean(data);
}

async function markEventProcessed(
  event: EventRow,
  outcome: DispatchOutcome,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const admin = createAdminClient();
  const metadata = mergeMetadata(event.metadata, {
    outcome,
    handled_by: DISPATCHER_KEY,
    handled_at: new Date().toISOString(),
    ...extra,
  });
  const consumed = uniquePush(event.consumed_by, DISPATCHER_KEY);
  const { error } = await admin
    .from("event_log")
    .update({
      status: "done",
      metadata,
      consumed_by: consumed,
      updated_at: new Date().toISOString(),
    })
    .eq("id", event.id);
  if (error) {
    logger.warn("[agent-dispatcher] markEventProcessed failed", {
      event_id: event.id,
      outcome,
      error: error.message,
    });
  }
}

async function requeueEvent(
  event: EventRow,
  delayMs: number,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const admin = createAdminClient();
  const nextAttemptAt = new Date(Date.now() + delayMs).toISOString();
  const metadata = mergeMetadata(event.metadata, {
    last_requeue: { ...extra, requeued_at: new Date().toISOString() },
  });
  const { error } = await admin
    .from("event_log")
    .update({
      status: "pending",
      attempts: (event.attempts ?? 0) + 1,
      next_attempt_at: nextAttemptAt,
      metadata,
      updated_at: new Date().toISOString(),
    })
    .eq("id", event.id);
  if (error) {
    logger.warn("[agent-dispatcher] requeueEvent failed", {
      event_id: event.id,
      error: error.message,
    });
  }
}

async function markEventFailed(event: EventRow, detail: string): Promise<void> {
  const admin = createAdminClient();
  const metadata = mergeMetadata(event.metadata, {
    outcome: "error",
    handled_by: DISPATCHER_KEY,
    handled_at: new Date().toISOString(),
  });
  const { error } = await admin
    .from("event_log")
    .update({
      status: "dead",
      last_error: detail.slice(0, 500),
      metadata,
      updated_at: new Date().toISOString(),
    })
    .eq("id", event.id);
  if (error) {
    logger.warn("[agent-dispatcher] markEventFailed failed", {
      event_id: event.id,
      error: error.message,
    });
  }
}

function mergeMetadata(
  current: Record<string, unknown> | null,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return { ...(current ?? {}), ...patch };
}

function uniquePush(arr: string[] | null | undefined, value: string): string[] {
  const list = Array.isArray(arr) ? arr.slice() : [];
  if (!list.includes(value)) list.push(value);
  return list;
}

function strOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// ---------------------------------------------------------------------------
// Runner invocation (fire-and-forget)
// ---------------------------------------------------------------------------

async function invokeRunner(runId: string): Promise<void> {
  const secret = env.INTERNAL_SECRET;
  if (!secret) {
    logger.warn("[agent-dispatcher] INTERNAL_SECRET missing — runner not invoked", { run_id: runId });
    return;
  }
  const baseUrl = env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const url = `${baseUrl.replace(/\/$/, "")}/api/internal/agents/run`;

  // Fire-and-forget: do not await the response. Best-effort logging only.
  void fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-secret": secret,
    },
    body: JSON.stringify({ run_id: runId }),
  }).catch((err) => {
    logger.warn("[agent-dispatcher] runner invoke failed", {
      run_id: runId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}
