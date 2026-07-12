/**
 * GET/POST /api/v1/cron/attendance-sla — varredura de SLA de atendimento (C4).
 *
 * Roda a cada minuto (tick real via crontab da VPS; fallback diário na Vercel
 * Hobby). Só age em tenants com attendance_settings.enabled=true.
 *
 * Auth: `Authorization: Bearer <INTERNAL_CRON_SECRET|INTERNAL_SECRET>` ou
 * header `X-Cron-Secret` (mesmo contrato do agent-dispatcher/event-log-drain).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { sweepAttendanceSla } from "@/lib/attendance/sla";

export const dynamic = "force-dynamic";

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
    summary = await sweepAttendanceSla(createAdminClient());
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("[attendance-sla.cron] sweep threw", { error: detail, requestId });
    return fail("internal_error", detail, 500, { requestId });
  }

  if (summary.reassigned || summary.escalated_to_manager || summary.first_response_alerts) {
    logger.info("[attendance-sla.cron] tick", { ...summary, requestId });
  }

  return ok(summary, { requestId, meta: { requestId } });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
