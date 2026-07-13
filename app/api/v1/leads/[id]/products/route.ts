/**
 * GET /api/v1/leads/[id]/products — imóveis/produtos do catálogo vinculados
 * ao lead (C3), pro diálogo do Kanban e telas fora do Inbox. RLS-scoped via
 * cookie session (mesma razão do crm-summary: browser client não tem sessão).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id: leadId } = await ctx.params;

  const supabase = await createClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }

  const { data, error } = await supabase
    .from("crm_lead_products")
    .select(
      "id, relation, note, created_at, product:crm_products(id, title, price_cents, currency, location, url, kind)",
    )
    .eq("lead_id", leadId)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) return fail("internal_error", error.message, 500, { requestId });

  return ok({ products: data ?? [] }, { requestId });
}
