/**
 * GET/POST /api/v1/cron/event-log-drain
 *
 * Cron driver que drena `event_log` e roteia cada linha pros handlers
 * registrados (ai-response-worker, ai-sentiment-worker, rag-indexer, LGPD…).
 * Esta rota era prometida pelo comentário de `lib/event-log/dispatcher.ts`
 * ("lives in app/api/v1/cron/event-log-drain/route.ts") mas NUNCA existiu no
 * fork — sem ela, todo `message.received` ficava `pending` pra sempre e o bot
 * jamais respondia.
 *
 * Auth: `Authorization: Bearer <INTERNAL_CRON_SECRET|INTERNAL_SECRET>` ou
 * header `X-Cron-Secret` (mesmo contrato do agent-dispatcher).
 *
 * Agendamento: 1 tick/min via crontab da VPS (Vercel Hobby só cron diário —
 * o vercel.ts mantém um fallback 1x/dia). Lote de 50 eventos por tick.
 *
 * Ciclo de vida (CHECK do event_log só permite pending|processing|done|dead):
 *   pending → processing (claim CAS) → done   (todos handlers ok/skipped)
 *                                    → pending (algum erro, attempts+backoff)
 *                                    → dead    (attempts >= MAX)
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  dispatchEvent,
  getRegisteredHandlers,
  type EventRow,
} from "@/lib/event-log/dispatcher";
import { ensureHandlersRegistered } from "@/lib/event-log/register-handlers";

export const dynamic = "force-dynamic";
// ai-response-worker chama LLM + embeddings — 1 lote pode passar fácil dos
// 10s default. Fluid compute cobre; teto igual ao do agents/run.
export const maxDuration = 300;

const BATCH_SIZE = 50;
const MAX_ATTEMPTS = 5;
const DRAIN_KEY = "worker.event-log-drain.v1";

/** Backoff exponencial: 30s, 60s, 120s, 240s… */
function backoffMs(attempts: number): number {
  return 30_000 * 2 ** Math.max(0, attempts - 1);
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const headerSecret = req.headers.get("x-cron-secret")?.trim() ?? "";
  const provided = bearer || headerSecret;

  const accepted: string[] = [];
  if (env.INTERNAL_CRON_SECRET) accepted.push(env.INTERNAL_CRON_SECRET);
  if (env.INTERNAL_SECRET) accepted.push(env.INTERNAL_SECRET);
  if (accepted.length === 0 || !provided || !accepted.includes(provided)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  if (!env.EVENT_LOG_WORKER_ENABLED) {
    return ok({ skipped: "EVENT_LOG_WORKER_ENABLED=false" }, { requestId });
  }

  ensureHandlersRegistered();
  const eventTypes = Array.from(
    new Set(getRegisteredHandlers().flatMap((h) => h.events)),
  );
  if (eventTypes.length === 0) {
    return ok({ skipped: "no_handlers_registered" }, { requestId });
  }

  const admin = createAdminClient();
  const nowIso = new Date().toISOString();

  const { data: rawEvents, error: pullErr } = await admin
    .from("event_log")
    .select(
      "id, organization_id, event_type, entity_kind, entity_id, payload, metadata, consumed_by, attempts",
    )
    .eq("status", "pending")
    .in("event_type", eventTypes)
    .or(`next_attempt_at.is.null,next_attempt_at.lte.${nowIso}`)
    .order("created_at", { ascending: true })
    .limit(BATCH_SIZE);

  if (pullErr) {
    return fail("internal_error", `event_log pull failed: ${pullErr.message}`, 500, {
      requestId,
    });
  }

  const events = (rawEvents ?? []) as unknown as EventRow[];
  const summary = { claimed: 0, done: 0, requeued: 0, dead: 0, no_handler: 0 };
  const errors: string[] = [];

  for (const event of events) {
    // Claim otimista (CAS pending→processing) — outro tick pode ter pego.
    const { data: claimed, error: claimErr } = await admin
      .from("event_log")
      .update({ status: "processing", updated_at: new Date().toISOString() })
      .eq("id", event.id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (claimErr || !claimed) continue;
    summary.claimed += 1;

    let results;
    try {
      results = await dispatchEvent({
        ...event,
        payload: event.payload ?? {},
        metadata: event.metadata ?? {},
        consumed_by: event.consumed_by ?? [],
      });
    } catch (err) {
      results = [
        {
          consumer_key: DRAIN_KEY,
          status: "error" as const,
          detail: err instanceof Error ? err.message : String(err),
        },
      ];
    }

    if (results.length === 0) {
      // Nenhum handler restante (todos já em consumed_by) — encerra a linha.
      await admin
        .from("event_log")
        .update({ status: "done", updated_at: new Date().toISOString() })
        .eq("id", event.id);
      summary.no_handler += 1;
      continue;
    }

    const okKeys = results
      .filter((r) => r.status === "ok" || r.status === "skipped")
      .map((r) => r.consumer_key);
    const failed = results.filter((r) => r.status === "error");
    const consumed = Array.from(new Set([...(event.consumed_by ?? []), ...okKeys]));

    if (failed.length === 0) {
      const { error: doneErr } = await admin
        .from("event_log")
        .update({
          status: "done",
          consumed_by: consumed,
          updated_at: new Date().toISOString(),
        })
        .eq("id", event.id);
      if (doneErr) {
        errors.push(`${event.id}: mark done failed: ${doneErr.message}`);
        logger.warn("[event-log-drain] mark done failed", {
          event_id: event.id,
          error: doneErr.message,
        });
      } else {
        summary.done += 1;
      }
      continue;
    }

    const attempts = (event.attempts ?? 0) + 1;
    const lastError = failed
      .map((r) => `${r.consumer_key}: ${r.detail ?? "error"}`)
      .join(" | ")
      .slice(0, 500);

    if (attempts >= MAX_ATTEMPTS) {
      await admin
        .from("event_log")
        .update({
          status: "dead",
          attempts,
          consumed_by: consumed,
          last_error: lastError,
          updated_at: new Date().toISOString(),
        })
        .eq("id", event.id);
      summary.dead += 1;
      errors.push(`${event.id}: dead after ${attempts} attempts: ${lastError}`);
    } else {
      await admin
        .from("event_log")
        .update({
          status: "pending",
          attempts,
          consumed_by: consumed,
          last_error: lastError,
          next_attempt_at: new Date(Date.now() + backoffMs(attempts)).toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", event.id);
      summary.requeued += 1;
      errors.push(`${event.id}: requeued (attempt ${attempts}): ${lastError}`);
    }
  }

  if (summary.claimed > 0) {
    logger.info("[event-log-drain] tick", { ...summary, errors: errors.length, requestId });
  }

  return ok({ ...summary, errors }, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
