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
import { varrerAlarmes } from "@/lib/ops/alarme-runs";

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

  // ⏰ O ALARME DE BOT QUEBRADO PEGA CARONA AQUI, e o motivo é prático.
  //
  // Ele tem rota própria (/api/v1/cron/alarme-runs), mas o plano Hobby da
  // Vercel só permite cron DIÁRIO, agendado às 00h50 BRT — e o alarme olha a
  // ÚLTIMA HORA. Na madrugada não há amostra, então o critério de volume mínimo
  // nunca fecharia: seria um alarme que não dispara nunca, não um alarme lento.
  //
  // O Darlei não quis outro tick no crontab da VPS (09/09/2026), então o alarme
  // vem de carona neste, que já bate a cada minuto. Custa duas consultas por
  // passada e o próprio alarme tem silêncio de 3h entre avisos iguais, então
  // não vira ruído nem carga.
  //
  // Falha aqui NÃO derruba a distribuição: a varredura de atendimento é o
  // trabalho principal desta rota, e o alarme é acessório.
  try {
    const alarme = await varrerAlarmes(createAdminClient());
    if (alarme.alarmes > 0 || alarme.errors.length > 0) {
      logger.warn("[attendance-sla.cron] alarme de bot", { ...alarme, requestId });
    }
  } catch (err) {
    logger.error("[attendance-sla.cron] varredura de alarme falhou (ignorada)", {
      error: err instanceof Error ? err.message : String(err),
      requestId,
    });
  }

  return ok(summary, { requestId, meta: { requestId } });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
