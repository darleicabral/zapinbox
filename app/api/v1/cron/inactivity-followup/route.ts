/**
 * GET/POST /api/v1/cron/inactivity-followup — cadência de reengajamento (C1).
 *
 * Roda a cada minuto (tick real via crontab da VPS; fallback diário na Vercel
 * Hobby). Só age em tenants com followup_settings.enabled=true. Envia mensagens
 * (throttle interno anti-banimento) — maxDuration folgado.
 *
 * Auth: `Authorization: Bearer <INTERNAL_CRON_SECRET|INTERNAL_SECRET>` ou
 * header `X-Cron-Secret` (mesmo contrato dos outros crons).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { sweepFollowups } from "@/lib/followup/followup";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

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

  let summary;
  try {
    summary = await sweepFollowups(createAdminClient());
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("[inactivity-followup.cron] sweep threw", { error: detail, requestId });
    return fail("internal_error", detail, 500, { requestId });
  }

  if (summary.sent || summary.discarded) {
    logger.info("[inactivity-followup.cron] tick", { ...summary, requestId });
  }

  return ok(summary, { requestId, meta: { requestId } });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
