/**
 * POST /api/v1/conversations/[id]/open-lead — abre um ATENDIMENTO a partir da
 * conversa (decisão Itaville 22/07: a abertura é MANUAL; a atendente decide
 * quem vira atendimento).
 *
 * Reincidente (#4): se o contato JÁ tem um atendimento aberto neste pipeline,
 * NÃO duplica — adiciona a tag "reincidente" ao atendimento aberto e o devolve.
 * Senão, cria um novo na 1ª etapa aberta do pipeline default da org, vinculado
 * ao contato. A classificação (categoria/nível/etc.) é preenchida depois pela
 * atendente no Kanban.
 *
 * Client de SESSÃO (RLS): o ator é membro da org.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { ok, fail } from "@/lib/api/wrappers";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const REINCIDENTE_TAG = "reincidente";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function POST(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id: conversationId } = await ctx.params;
  const supabase = await createClient();

  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) return fail("unauthenticated", "Auth required.", 401, { requestId });

  // Conversa (RLS) + contato embutido.
  const { data: conv, error: convErr } = await supabase
    .from("conversations")
    .select("id, organization_id, contact_id, contacts:contact_id(display_name, name, phone_number)")
    .eq("id", conversationId)
    .maybeSingle();
  if (convErr) return fail("internal_error", convErr.message, 500, { requestId });
  if (!conv) return fail("not_found", "Conversa não encontrada.", 404, { requestId });

  const orgId = (conv as { organization_id: string }).organization_id;
  const contactId = (conv as { contact_id: string | null }).contact_id;
  if (!contactId) {
    return fail("conversation_without_contact", "A conversa não tem contato vinculado.", 422, { requestId });
  }
  const contact = (conv as unknown as {
    contacts: { display_name: string | null; name: string | null; phone_number: string | null } | null;
  }).contacts;
  const title =
    contact?.display_name?.trim() || contact?.name?.trim() || contact?.phone_number?.trim() || "Atendimento WhatsApp";

  // Pipeline default da org + 1ª etapa aberta.
  const { data: pipeline } = await supabase
    .from("crm_pipelines")
    .select("id")
    .eq("organization_id", orgId)
    .eq("is_default", true)
    .eq("is_archived", false)
    .limit(1)
    .maybeSingle();
  if (!pipeline) return fail("no_default_pipeline", "Org sem pipeline default.", 422, { requestId });
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
    const ex = existing as { id: string; title: string; tags: string[] | null; external_id: string | null };
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
      actorUserId: user.id,
      organizationId: orgId,
      resourceType: "crm_lead",
      resourceId: ex.id,
      requestId,
      metadata: { conversation_id: conversationId, reincidente: true },
    });
    return ok(
      { lead_id: ex.id, title: ex.title, external_id: ex.external_id, created: false, reincidente: true },
      { requestId },
    );
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
  if (!stage) return fail("no_open_stage", "Pipeline sem etapa aberta.", 422, { requestId });

  const { data: created, error: insErr } = await supabase
    .from("crm_leads")
    .insert({
      organization_id: orgId,
      pipeline_id: pipelineId,
      stage_id: (stage as { id: string }).id,
      contact_id: contactId,
      title,
      status: "open",
      source: "manual",
      custom_fields: {},
    })
    .select("id, title, external_id")
    .single();
  if (insErr || !created) return fail("internal_error", insErr?.message ?? "insert falhou", 500, { requestId });

  const lead = created as { id: string; title: string; external_id: string | null };

  await supabase
    .rpc("emit_event", {
      p_event_type: "lead.created",
      p_entity_kind: "crm_lead",
      p_entity_id: lead.id,
      p_payload: { source: "manual", from_conversation: conversationId },
      p_metadata: { request_id: requestId, actor_user_id: user.id },
      p_organization_id: orgId,
    })
    .then(({ error }) => {
      if (error) console.error("[open-lead] emit_event failed", error.message);
    });

  await audit({
    action: "lead.created",
    actorUserId: user.id,
    organizationId: orgId,
    resourceType: "crm_lead",
    resourceId: lead.id,
    requestId,
    metadata: { from_conversation: conversationId, source: "manual" },
  });

  return ok(
    { lead_id: lead.id, title: lead.title, external_id: lead.external_id, created: true, reincidente: false },
    { requestId },
  );
}
