/**
 * GET /api/v1/reports/posvenda — agrega o painel de pós-venda/crise da org ativa.
 *
 * Tenant-scoped: usa o client com sessão (cookie) + resolveActiveOrg; a RLS de
 * crm_leads já isola por org, e ainda filtramos por organization_id por garantia.
 * Agregação em JS (lib/reports/posvenda.ts) — mesmo padrão do dashboard admin.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { createClient } from "@/lib/supabase/server";
import { computePosvendaReport, type ReportLeadRow } from "@/lib/reports/posvenda";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const supabase = await createClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }

  const authUser = await loadAuthUser();
  const activeOrg = authUser ? await resolveActiveOrg(authUser) : null;
  if (!activeOrg) {
    return fail("no_active_org", "Nenhuma organização ativa.", 403, { requestId });
  }

  const { data, error: qErr } = await supabase
    .from("crm_leads")
    .select("id, contact_id, created_at, custom_fields, stage:crm_stages(name,is_won,is_lost)")
    .eq("organization_id", activeOrg.orgId)
    .limit(5000);

  if (qErr) {
    return fail("query_failed", qErr.message, 500, { requestId });
  }

  const report = computePosvendaReport((data ?? []) as unknown as ReportLeadRow[]);
  return ok(report, { requestId });
}
