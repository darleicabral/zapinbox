/**
 * "Abrir atendimento": RESOLVE para onde levar a atendente, sem criar nada.
 *
 * Decisão Darlei (26/07): o botão não cria mais o atendimento por baixo do pano
 * — ele abre a tela de NOVO ATENDIMENTO (a que tem a busca de comprador), com o
 * contato já vinculado e o que der pra pré-preencher. Quem cria é o formulário,
 * via POST /api/v1/leads, que é o caminho com numeração de chamado (VG-2026-001),
 * validação de campos obrigatórios e automações.
 *
 * Fonte única das duas portas de entrada:
 *   - Inbox    → POST /api/v1/conversations/[id]/open-lead (prefill da triagem)
 *   - Contatos → POST /api/v1/contacts/[id]/open-lead      (prefill do cadastro)
 *
 * Reincidente: se o contato JÁ tem atendimento aberto no pipeline default, não
 * abre formulário nenhum — marca a tag `reincidente` no existente e manda a
 * atendente pra ele.
 *
 * Recebe um client de SESSÃO (RLS): o ator é membro da org.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";

export const REINCIDENTE_TAG = "reincidente";

export interface OpenLeadTarget {
  pipeline_id: string;
  /** Preenchido só quando já existe atendimento aberto do contato. */
  lead_id: string | null;
  external_id: string | null;
  reincidente: boolean;
}

export interface OpenLeadTargetInput {
  orgId: string;
  contactId: string;
  actorUserId: string;
  requestId: string;
  /** Origem, só para audit (ex.: `{ from_conversation: "…" }`). */
  origin?: Record<string, unknown>;
}

export type OpenLeadOutcome =
  | { ok: true; result: OpenLeadTarget }
  | { ok: false; code: string; message: string; status: number };

export async function resolveOpenLeadTarget(
  supabase: SupabaseClient,
  input: OpenLeadTargetInput,
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
    .select("id, tags, external_id")
    .eq("organization_id", orgId)
    .eq("pipeline_id", pipelineId)
    .eq("contact_id", contactId)
    .eq("status", "open")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!existing) {
    return {
      ok: true,
      result: { pipeline_id: pipelineId, lead_id: null, external_id: null, reincidente: false },
    };
  }

  const ex = existing as { id: string; tags: string[] | null; external_id: string | null };
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
      pipeline_id: pipelineId,
      lead_id: ex.id,
      external_id: ex.external_id,
      reincidente: true,
    },
  };
}
