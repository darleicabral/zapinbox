/**
 * MCP tool — crm_save_lead_profile (C2: extração de dados → CRM).
 *
 * O agente vivo chama esta tool pra gravar no CRM o que descobriu sobre o
 * cliente durante a conversa (qualificação). Genérica por design: as CHAVES do
 * `profile` são definidas pelo prompt do tenant (imobiliária captura coisas
 * diferentes de e-commerce), então nada é chumbado pra Avant aqui.
 *
 * Efeitos:
 *  - resolve o lead aberto do contato; se não existir, CRIA no pipeline default
 *    (1ª etapa não-ganho/não-perdido);
 *  - merge de `profile` em `crm_leads.custom_fields` (novas chaves vencem);
 *  - opcional: preenche o nome do contato (só se estiver vazio) e a descrição
 *    do lead (resumo do interesse);
 *  - emite `lead.profile_updated`.
 */
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { McpToolDefinition } from "../types";

const profileValue = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);

const inputShape = {
  conversation_id: z.string().uuid(),
  profile: z
    .record(z.string().min(1).max(60), profileValue)
    .describe(
      "Campos de qualificação a gravar/atualizar no lead (merge). Ex. imobiliária: tipo_imovel, bairros_interesse, orcamento_max, quartos, forma_pagamento, renda_aprox, finalidade. Use snake_case e seja consistente nas chaves.",
    ),
  contact_name: z.string().min(1).max(120).optional().describe("Nome do cliente, se descoberto."),
  interest_summary: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe("Resumo curto do que o cliente procura (vira a descrição do lead)."),
};

async function resolveOrCreateLead(
  supabase: SupabaseClient,
  orgId: string,
  contactId: string,
  title: string,
): Promise<{ id: string; custom_fields: Record<string, unknown>; created: boolean } | null> {
  const { data: existing } = await supabase
    .from("crm_leads")
    .select("id, custom_fields, status")
    .eq("organization_id", orgId)
    .eq("contact_id", contactId)
    .eq("status", "open")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing) {
    return {
      id: (existing as { id: string }).id,
      custom_fields: ((existing as { custom_fields: Record<string, unknown> }).custom_fields ?? {}),
      created: false,
    };
  }

  // Cria no pipeline default, 1ª etapa aberta (não-ganho/não-perdido).
  const { data: pipeline } = await supabase
    .from("crm_pipelines")
    .select("id")
    .eq("organization_id", orgId)
    .eq("is_default", true)
    .eq("is_archived", false)
    .limit(1)
    .maybeSingle();
  if (!pipeline) return null;
  const pipelineId = (pipeline as { id: string }).id;

  const { data: stage } = await supabase
    .from("crm_stages")
    .select("id")
    .eq("organization_id", orgId)
    .eq("pipeline_id", pipelineId)
    .eq("is_won", false)
    .eq("is_lost", false)
    .eq("is_archived", false)
    .order("position", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!stage) return null;

  const { data: created, error } = await supabase
    .from("crm_leads")
    .insert({
      organization_id: orgId,
      pipeline_id: pipelineId,
      stage_id: (stage as { id: string }).id,
      contact_id: contactId,
      title,
      status: "open",
      source: "ai_agent",
      custom_fields: {},
    })
    .select("id, custom_fields")
    .single();
  if (error || !created) return null;
  return { id: (created as { id: string }).id, custom_fields: {}, created: true };
}

export const crmSaveLeadProfile: McpToolDefinition<typeof inputShape> = {
  name: "crm_save_lead_profile",
  description:
    "Grava no CRM os dados de qualificação descobertos sobre o cliente (perfil do lead). Chame SEMPRE que a conversa revelar algo útil (tipo de imóvel/produto, bairro/região, faixa de preço ou orçamento, quantidade de quartos, forma de pagamento, renda, prazo etc.), mesmo que parcial. Cria o lead se ainda não existir e faz merge — não sobrescreve o que já foi salvo. Não invente dados; só grave o que o cliente disse.",
  inputSchema: inputShape,
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

    const contact = (conv as unknown as {
      contacts: { display_name: string | null; name: string | null } | null;
    }).contacts;

    // Preenche o nome do contato só se estiver vazio (não sobrescreve dado humano).
    if (input.contact_name && !contact?.name?.trim()) {
      await ctx.supabase
        .from("contacts")
        .update({
          name: input.contact_name,
          ...(contact?.display_name?.trim() ? {} : { display_name: input.contact_name }),
        })
        .eq("id", contactId)
        .eq("organization_id", ctx.organizationId);
    }

    const title =
      input.contact_name?.trim() ||
      contact?.display_name?.trim() ||
      contact?.name?.trim() ||
      "Lead WhatsApp";

    const lead = await resolveOrCreateLead(ctx.supabase, ctx.organizationId, contactId, title);
    if (!lead) throw new Error("lead_resolve_failed_no_default_pipeline");

    const mergedCustom = { ...lead.custom_fields, ...input.profile };
    const patch: Record<string, unknown> = {
      custom_fields: mergedCustom,
      last_activity_at: new Date().toISOString(),
    };
    if (input.interest_summary) patch.description = input.interest_summary;

    const { error: updErr } = await ctx.supabase
      .from("crm_leads")
      .update(patch)
      .eq("id", lead.id)
      .eq("organization_id", ctx.organizationId);
    if (updErr) throw new Error(updErr.message);

    await ctx.supabase.rpc("emit_event" as never, {
      p_event_type: "lead.profile_updated",
      p_entity_kind: "crm_lead",
      p_entity_id: lead.id,
      p_payload: { lead_id: lead.id, keys: Object.keys(input.profile), created: lead.created },
      p_metadata: { source: "crm_save_lead_profile" },
      p_organization_id: ctx.organizationId,
    } as never);

    return {
      lead_id: lead.id,
      lead_created: lead.created,
      saved_keys: Object.keys(input.profile),
      next_action: "Continue o atendimento normalmente; não avise o cliente que salvou dados.",
    };
  },
};
