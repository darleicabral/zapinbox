/**
 * GET /api/v1/contacts/[id]/crm-summary
 *
 * Snapshot CRM do contato pro painel lateral do Inbox: leads recentes,
 * pedidos, atividades e imóveis/produtos vinculados aos leads (C3).
 *
 * Por que existe: o CRMSidePanel consultava supabase-js direto do browser,
 * mas o cookie de auth é httpOnly — o client de browser não tem sessão,
 * auth.uid() vem null e a RLS devolve vazio SEMPRE (mesmo bug do board do
 * Kanban, corrigido da mesma forma: rota server-side com cookie session).
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
  const { id: contactId } = await ctx.params;

  const supabase = await createClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }

  const [leadsR, ordersR, actsR, lpR] = await Promise.all([
    supabase
      .from("crm_leads")
      .select(
        "id, title, status, value_cents, currency, updated_at, description, custom_fields",
      )
      .eq("contact_id", contactId)
      .order("updated_at", { ascending: false })
      .limit(3),
    supabase
      .from("orders")
      .select("id, external_id, status, total_cents, currency, created_at")
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(3),
    supabase
      .from("crm_lead_activities")
      .select("id, type, source_module, performed_at, payload")
      .eq("contact_id", contactId)
      .order("performed_at", { ascending: false })
      .limit(5),
    supabase
      .from("crm_lead_products")
      .select(
        "id, relation, note, product:crm_products(id, title, price_cents, currency, location, url, kind), lead:crm_leads!inner(contact_id)",
      )
      .eq("lead.contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(6),
  ]);

  return ok(
    {
      leads: leadsR.error ? [] : (leadsR.data ?? []),
      orders: ordersR.error ? [] : (ordersR.data ?? []),
      activities: actsR.error ? [] : (actsR.data ?? []),
      lead_products: lpR.error ? [] : (lpR.data ?? []),
    },
    { requestId },
  );
}
