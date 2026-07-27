/**
 * Abertura MANUAL de atendimento a partir de um CONTATO (decisão Itaville
 * 22/07: quem decide o que vira atendimento é a atendente, não a IA).
 *
 * Fonte única das duas portas de entrada:
 *   - Inbox  → POST /api/v1/conversations/[id]/open-lead (prefill da triagem)
 *   - Contatos → POST /api/v1/contacts/[id]/open-lead    (prefill do cadastro)
 *
 * Reincidente: se o contato JÁ tem atendimento aberto no pipeline default, NÃO
 * duplica — marca a tag `reincidente` no existente e devolve ele.
 *
 * Recebe um client de SESSÃO (RLS): o ator é membro da org.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";

export const REINCIDENTE_TAG = "reincidente";

export interface OpenLeadResult {
  lead_id: string;
  pipeline_id: string;
  title: string;
  external_id: string | null;
  created: boolean;
  reincidente: boolean;
}

export interface OpenLeadInput {
  orgId: string;
  contactId: string;
  actorUserId: string;
  requestId: string;
  title: string;
  /** custom_fields do atendimento NOVO (o reincidente não é tocado). */
  prefill?: Record<string, unknown>;
  description?: string | null;
  /** Origem, só para audit/event (ex.: `{ from_conversation: "…" }`). */
  origin?: Record<string, unknown>;
}

export type OpenLeadOutcome =
  | { ok: true; result: OpenLeadResult }
  | { ok: false; code: string; message: string; status: number };

export async function openLeadForContact(
  supabase: SupabaseClient,
  input: OpenLeadInput,
): Promise<OpenLeadOutcome> {
  const { orgId, contactId, actorUserId, requestId } = input;
  const origin = input.origin ?? {};

  const { data: pipeline } = await supabase
    .from("crm_pipelines")
    .select("id")
    .eq("organization_id", orgId)
    .eq("is_default", true)
    .eq("is_archived", false)
    .limit(1)
    .maybeSingle();
  if (!pipeline) {
    return {
      ok: false,
      code: "no_default_pipeline",
      message: "Org sem pipeline default.",
      status: 422,
    };
  }
  const pipelineId = (pipeline as { id: string }).id;

  // Reincidente: já existe atendimento ABERTO deste contato neste pipeline?
  const { data: existing } = await supabase
    .from("crm_leads")
    .select("id, title, tags, external_id")
    .eq("organization_id", orgId)
    .eq("pipeline_id", pipelineId)
    .eq("contact_id", contactId)
    .eq("status", "open")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing) {
    const ex = existing as {
      id: string;
      title: string;
      tags: string[] | null;
      external_id: string | null;
    };
    const tags = ex.tags ?? [];
    if (!tags.includes(REINCIDENTE_TAG)) {
      await supabase
        .from("crm_leads")
        .update({ tags: [...tags, REINCIDENTE_TAG], last_activity_at: new Date().toISOString() })
        .eq("id", ex.id)
        .eq("organization_id", orgId);
    }
    await audit({
      action: "lead.updated",
      actorUserId,
      organizationId: orgId,
      resourceType: "crm_lead",
      resourceId: ex.id,
      requestId,
      metadata: { ...origin, reincidente: true },
    });
    return {
      ok: true,
      result: {
        lead_id: ex.id,
        pipeline_id: pipelineId,
        title: ex.title,
        external_id: ex.external_id,
        created: false,
        reincidente: true,
      },
    };
  }

  // 1ª etapa aberta (não-ganho/não-perdido).
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
  if (!stage) {
    return { ok: false, code: "no_open_stage", message: "Pipeline sem etapa aberta.", status: 422 };
  }

  const { data: created, error: insErr } = await supabase
    .from("crm_leads")
    .insert({
      organization_id: orgId,
      pipeline_id: pipelineId,
      stage_id: (stage as { id: string }).id,
      contact_id: contactId,
      title: input.title,
      status: "open",
      source: "manual",
      custom_fields: input.prefill ?? {},
      ...(input.description ? { description: input.description } : {}),
    })
    .select("id, title, external_id")
    .single();
  if (insErr || !created) {
    return {
      ok: false,
      code: "internal_error",
      message: insErr?.message ?? "insert falhou",
      status: 500,
    };
  }

  const lead = created as { id: string; title: string; external_id: string | null };

  await supabase
    .rpc("emit_event", {
      p_event_type: "lead.created",
      p_entity_kind: "crm_lead",
      p_entity_id: lead.id,
      p_payload: { source: "manual", ...origin },
      p_metadata: { request_id: requestId, actor_user_id: actorUserId },
      p_organization_id: orgId,
    })
    .then(({ error }) => {
      if (error) console.error("[open-lead] emit_event failed", error.message);
    });

  await audit({
    action: "lead.created",
    actorUserId,
    organizationId: orgId,
    resourceType: "crm_lead",
    resourceId: lead.id,
    requestId,
    metadata: { ...origin, source: "manual" },
  });

  return {
    ok: true,
    result: {
      lead_id: lead.id,
      pipeline_id: pipelineId,
      title: lead.title,
      external_id: lead.external_id,
      created: true,
      reincidente: false,
    },
  };
}
