/**
 * GET /api/v1/public/itaville-dashboard — agregados do Dashboard da Diretoria
 * (Itaville), consumidos pela página estática externa
 * (dashboard-diretoria-itaville/index.html, hospedada fora do CRM).
 *
 * PÚBLICA por design (Opção A da decisão 22/07 — ver ESTADO.md): token simples
 * no lugar de sessão, CORS liberado (a página estática roda noutro domínio), e
 * a resposta é SÓ AGREGADOS — nenhum dado pessoal (nome/telefone/CPF) trafega.
 *
 * Auth: `Authorization: Bearer <ITAVILLE_DASHBOARD_TOKEN>` ou `?token=`.
 * Org/pipeline da Itaville chumbados de propósito (rota de tenant único).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { computeDiretoriaDashboard, type DiretoriaLeadRow } from "@/lib/reports/diretoria-dashboard";

export const dynamic = "force-dynamic";

const ITAVILLE_ORG_ID = "bd014ed4-f62f-42f3-b092-3182cef3ef0b";
const ITAVILLE_PIPELINE_ID = "2b91e2f1-070c-47b3-b4e8-7d32cc5e03fd";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization",
};

function unauthorized(requestId: string): Response {
  return Response.json({ ok: false, error: "unauthorized", requestId }, { status: 401, headers: CORS_HEADERS });
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!env.ITAVILLE_DASHBOARD_TOKEN) return unauthorized(requestId);
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const queryToken = req.nextUrl.searchParams.get("token") ?? "";
  const provided = bearer || queryToken;
  if (provided !== env.ITAVILLE_DASHBOARD_TOKEN) return unauthorized(requestId);

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("crm_leads")
    .select("status, created_at, closed_at, custom_fields, stage:crm_stages(name)")
    .eq("organization_id", ITAVILLE_ORG_ID)
    .eq("pipeline_id", ITAVILLE_PIPELINE_ID)
    .limit(10000);

  if (error) {
    return Response.json({ ok: false, error: error.message, requestId }, { status: 500, headers: CORS_HEADERS });
  }

  const dashboard = computeDiretoriaDashboard((data ?? []) as unknown as DiretoriaLeadRow[], new Date());
  return Response.json({ ok: true, data: dashboard, requestId }, { status: 200, headers: CORS_HEADERS });
}
