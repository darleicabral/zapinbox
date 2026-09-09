/**
 * GET/POST /api/v1/cron/alarme-runs — o alarme de bot quebrado.
 *
 * Existe porque em 06–08/09/2026 o bot da Avant ficou dois dias inteiros fora
 * do ar, 156 execuções falharam em sequência e NINGUÉM foi avisado. Ver a
 * explicação inteira em lib/ops/alarme-runs.ts.
 *
 * Cadência: de 15 em 15 minutos é suficiente — a janela de observação é de uma
 * hora e o próprio alarme não repete antes de 3h. Fallback diário na Vercel
 * Hobby; o tick real vem do crontab da VPS, igual aos outros crons:
 *   *\/15 * * * * curl -s -X POST https://crm.zapinbox.com.br/api/v1/cron/alarme-runs \
 *       -H "Authorization: Bearer $INTERNAL_SECRET"
 *
 * Auth: `Authorization: Bearer <INTERNAL_CRON_SECRET|INTERNAL_SECRET>` ou
 * header `X-Cron-Secret` — mesmo contrato dos outros crons.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { varrerAlarmes } from "@/lib/ops/alarme-runs";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
/** Envio pelo WAHA por gestor, com conferência de chatId. Folga suficiente. */
export const maxDuration = 120;

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
    summary = await varrerAlarmes(createAdminClient());
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("[alarme-runs.cron] varredura falhou", { error: detail, requestId });
    return fail("internal_error", detail, 500, { requestId });
  }

  // Só loga quando ALARMOU ou quando o alarme não conseguiu sair. Tick silencioso
  // não vira linha de log: o log deste cron precisa significar algo.
  if (summary.alarmes > 0 || summary.errors.length > 0) {
    logger.warn("[alarme-runs.cron] alarme", { ...summary, requestId });
  }

  return ok(summary, { requestId, meta: { requestId } });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
