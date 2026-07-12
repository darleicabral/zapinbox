/**
 * MCP tools — C3: catálogo estruturado de produtos/imóveis por lead.
 *
 *  - crm_search_catalog (read): busca no catálogo estruturado da org
 *    (`crm_products`) por texto/preço e devolve itens COM id — o que o RAG
 *    (crm_search_knowledge) não faz. É o id que permite anexar ao lead.
 *  - crm_link_lead_product (write): anexa um ou mais imóveis/produtos ao lead
 *    do contato (cria o lead se ainda não existir, mesma lógica do C2).
 *
 * Genéricas por design: `crm_products` tem colunas universais + `attributes`
 * jsonb livre por tenant. Nada é chumbado pra Avant aqui.
 */
import { z } from "zod";

import type { McpToolDefinition } from "../types";
import { resolveOrCreateLead } from "./lead-profile";

// ─── crm_search_catalog ──────────────────────────────────────────────────────

const searchShape = {
  query: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe("Texto livre — casa com título, descrição ou localização (ex.: 'apartamento Floramar')."),
  min_price: z
    .number()
    .nonnegative()
    .optional()
    .describe("Preço mínimo em REAIS (não centavos)."),
  max_price: z
    .number()
    .nonnegative()
    .optional()
    .describe("Preço máximo em REAIS (não centavos)."),
  kind: z.string().min(1).max(40).optional().describe("Tipo do item (ex.: 'imovel')."),
  limit: z.number().int().min(1).max(20).default(8),
};

interface ProductRow {
  id: string;
  title: string;
  description: string | null;
  kind: string;
  price_cents: number | null;
  currency: string;
  location: string | null;
  url: string | null;
  attributes: Record<string, unknown> | null;
}

export const crmSearchCatalog: McpToolDefinition<typeof searchShape> = {
  name: "crm_search_catalog",
  description:
    "Busca no catálogo estruturado da empresa (imóveis/produtos cadastrados) e devolve os itens com ID, título, preço e atributos. Use quando o cliente demonstrar interesse concreto (bairro/faixa de preço/tipo) e você precisar de itens específicos para apresentar OU para anexar ao lead com crm_link_lead_product. Diferente da base de conhecimento: aqui os itens têm ID e podem ser vinculados ao lead.",
  inputSchema: searchShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    let q = ctx.supabase
      .from("crm_products")
      .select("id, title, description, kind, price_cents, currency, location, url, attributes")
      .eq("organization_id", ctx.organizationId)
      .eq("status", "active");

    if (input.kind) q = q.eq("kind", input.kind);
    if (typeof input.min_price === "number") q = q.gte("price_cents", Math.round(input.min_price * 100));
    if (typeof input.max_price === "number") q = q.lte("price_cents", Math.round(input.max_price * 100));
    if (input.query) {
      const term = input.query.replace(/[%,]/g, " ").trim();
      // Busca em título OU descrição OU localização.
      q = q.or(`title.ilike.%${term}%,description.ilike.%${term}%,location.ilike.%${term}%`);
    }

    const { data, error } = await q
      .order("price_cents", { ascending: true, nullsFirst: false })
      .limit(input.limit);
    if (error) throw new Error(error.message);

    const rows = (data ?? []) as ProductRow[];
    return {
      count: rows.length,
      products: rows.map((p) => ({
        id: p.id,
        title: p.title,
        kind: p.kind,
        price:
          p.price_cents == null
            ? null
            : { amount: p.price_cents / 100, currency: p.currency },
        location: p.location,
        url: p.url,
        attributes: p.attributes ?? {},
        summary: p.description?.slice(0, 240) ?? null,
      })),
      next_action:
        "Para registrar o interesse do cliente, chame crm_link_lead_product com os id(s) escolhidos.",
    };
  },
};

// ─── crm_link_lead_product ───────────────────────────────────────────────────

const linkShape = {
  conversation_id: z.string().uuid(),
  product_ids: z
    .array(z.string().uuid())
    .min(1)
    .max(10)
    .describe("IDs vindos de crm_search_catalog dos imóveis/produtos de interesse do cliente."),
  relation: z
    .enum(["interest", "proposal", "visit", "discarded"])
    .default("interest")
    .describe("Relação do lead com o item: interest (interesse), proposal, visit (visita), discarded."),
  note: z.string().max(300).optional().describe("Observação curta (ex.: 'quer visitar no sábado')."),
};

export const crmLinkLeadProduct: McpToolDefinition<typeof linkShape> = {
  name: "crm_link_lead_product",
  description:
    "Anexa um ou mais imóveis/produtos do catálogo ao lead do cliente (registra o interesse de forma estruturada, visível pro corretor no painel). Use os IDs devolvidos por crm_search_catalog. Cria o lead se ainda não existir e não duplica vínculos. Não invente IDs.",
  inputSchema: linkShape,
  category: "write",
  requiresRole: "agent",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const { data: conv, error: convErr } = await ctx.supabase
      .from("conversations")
      .select("id, organization_id, contact_id, contacts:contact_id(display_name, name)")
      .eq("id", input.conversation_id)
      .maybeSingle();
    if (convErr) throw new Error(convErr.message);
    if (!conv || conv.organization_id !== ctx.organizationId) throw new Error("conversation_not_found");
    const contactId = (conv as { contact_id: string | null }).contact_id;
    if (!contactId) throw new Error("conversation_without_contact");

    // Só vincula produtos que existem E são da org (evita cross-tenant / id inventado).
    const { data: valid, error: prodErr } = await ctx.supabase
      .from("crm_products")
      .select("id, title")
      .eq("organization_id", ctx.organizationId)
      .in("id", input.product_ids);
    if (prodErr) throw new Error(prodErr.message);
    const validRows = (valid ?? []) as { id: string; title: string }[];
    if (validRows.length === 0) throw new Error("no_valid_products");

    const contact = (conv as unknown as {
      contacts: { display_name: string | null; name: string | null } | null;
    }).contacts;
    const title =
      contact?.display_name?.trim() || contact?.name?.trim() || "Lead WhatsApp";

    const lead = await resolveOrCreateLead(ctx.supabase, ctx.organizationId, contactId, title);
    if (!lead) throw new Error("lead_resolve_failed_no_default_pipeline");

    const rows = validRows.map((p) => ({
      organization_id: ctx.organizationId,
      lead_id: lead.id,
      product_id: p.id,
      relation: input.relation ?? "interest",
      note: input.note ?? null,
      created_by: "ai",
    }));

    const { error: upErr } = await ctx.supabase
      .from("crm_lead_products")
      .upsert(rows, { onConflict: "lead_id,product_id" });
    if (upErr) throw new Error(upErr.message);

    await ctx.supabase
      .from("crm_leads")
      .update({ last_activity_at: new Date().toISOString() })
      .eq("id", lead.id)
      .eq("organization_id", ctx.organizationId);

    await ctx.supabase.rpc("emit_event" as never, {
      p_event_type: "lead.products_linked",
      p_entity_kind: "crm_lead",
      p_entity_id: lead.id,
      p_payload: {
        lead_id: lead.id,
        product_ids: validRows.map((p) => p.id),
        relation: input.relation ?? "interest",
        created: lead.created,
      },
      p_metadata: { source: "crm_link_lead_product" },
      p_organization_id: ctx.organizationId,
    } as never);

    return {
      lead_id: lead.id,
      lead_created: lead.created,
      linked: validRows.map((p) => ({ id: p.id, title: p.title })),
      next_action: "Continue o atendimento; não avise o cliente que registrou os itens.",
    };
  },
};
