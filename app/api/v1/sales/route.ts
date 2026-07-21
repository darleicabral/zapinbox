/**
 * GET /api/v1/sales — base de vendas (compradores) da org ativa.
 *
 * Reusa a tabela genérica `crm_products` com kind='venda' (importada de uma
 * planilha por tenant via scripts/import-catalog.ts). Serve o auto-preenchimento
 * do diálogo de novo chamado: o operador escolhe empreendimento → unidade e os
 * dados do comprador preenchem o formulário (ver components/kanban/BuyerLookup).
 *
 * Tenant-scoped: client com sessão (cookie) + resolveActiveOrg; a RLS de
 * crm_products já isola por org, e ainda filtramos por organization_id.
 * Volume real é pequeno (algumas centenas), então devolvemos tudo de uma vez e
 * a UI monta os dois menus (empreendimento/unidade) em memória.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface SaleAttributes {
  empreendimento?: string | null;
  unidade?: string | null;
  cliente?: string | null;
  cpf?: string | null;
  email?: string | null;
  phone_e164?: string | null;
  corretor?: string | null;
  imobiliaria?: string | null;
  profissao?: string | null;
  tipo_unidade?: string | null;
  intencao_compra?: string | null;
  data_venda?: string | null;
  situacao?: string | null;
}

interface ProductRow {
  id: string;
  title: string | null;
  location: string | null;
  price_cents: number | null;
  attributes: SaleAttributes | null;
}

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
    .from("crm_products")
    .select("id, title, location, price_cents, attributes")
    .eq("organization_id", activeOrg.orgId)
    .eq("kind", "venda")
    .eq("status", "active")
    .limit(5000);

  if (qErr) {
    return fail("query_failed", qErr.message, 500, { requestId });
  }

  const sales = ((data ?? []) as ProductRow[]).map((r) => {
    const a = r.attributes ?? {};
    return {
      id: r.id,
      empreendimento: a.empreendimento ?? r.location ?? null,
      unidade: a.unidade ?? null,
      cliente: a.cliente ?? r.title ?? null,
      phone_e164: a.phone_e164 ?? null,
      email: a.email ?? null,
      cpf: a.cpf ?? null,
      corretor: a.corretor ?? null,
      imobiliaria: a.imobiliaria ?? null,
      profissao: a.profissao ?? null,
      tipo_unidade: a.tipo_unidade ?? null,
      intencao_compra: a.intencao_compra ?? null,
      valor_cents: r.price_cents ?? null,
    };
  });

  return ok(sales, { requestId });
}
