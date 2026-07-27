/**
 * POST /api/v1/conversations/[id]/open-lead — responde PARA ONDE ir quando a
 * atendente clica em "Abrir atendimento" dentro de uma conversa do Inbox.
 *
 * Não cria nada (decisão Darlei 26/07): devolve o pipeline, o atendimento
 * aberto que já existe (se houver) e o pré-preenchimento vindo da sinalização
 * da IA, para a tela de Novo Atendimento abrir preenchida. Quem cria é o
 * formulário (POST /api/v1/leads). Ver `lib/leads/open-lead.ts`.
 *
 * Client de SESSÃO (RLS): o ator é membro da org.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { resolveOpenLeadTarget } from "@/lib/leads/open-lead";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

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
    .select(
      "id, organization_id, contact_id, metadata, contacts:contact_id(display_name, name, phone_number, custom_fields)",
    )
    .eq("id", conversationId)
    .maybeSingle();
  if (convErr) return fail("internal_error", convErr.message, 500, { requestId });
  if (!conv) return fail("not_found", "Conversa não encontrada.", 404, { requestId });

  const orgId = (conv as { organization_id: string }).organization_id;
  const contactId = (conv as { contact_id: string | null }).contact_id;
  if (!contactId) {
    return fail("conversation_without_contact", "A conversa não tem contato vinculado.", 422, {
      requestId,
    });
  }
  const contact = (
    conv as unknown as {
      contacts: {
        display_name: string | null;
        name: string | null;
        phone_number: string | null;
        custom_fields: Record<string, unknown> | null;
      } | null;
    }
  ).contacts;

  const outcome = await resolveOpenLeadTarget(supabase, {
    orgId,
    contactId,
    actorUserId: user.id,
    requestId,
    origin: { from_conversation: conversationId },
  });
  if (!outcome.ok) {
    return fail(outcome.code, outcome.message, outcome.status, { requestId });
  }

  // Pré-preenchimento a partir da sinalização da IA (metadata.triagem) — a
  // atendente confere e edita no formulário antes de criar.
  const triagem = ((conv as { metadata: Record<string, unknown> | null }).metadata?.triagem ??
    null) as {
    categoria_sugerida?: string;
    nivel_sugerido?: string;
    resumo?: string;
  } | null;
  const prefill: Record<string, unknown> = { canal: "WhatsApp" };
  if (triagem?.categoria_sugerida) prefill.categoria = triagem.categoria_sugerida;
  if (triagem?.nivel_sugerido) prefill.nivel_acompanhamento = triagem.nivel_sugerido;
  const empreendimento = contact?.custom_fields?.empreendimento;
  if (typeof empreendimento === "string" && empreendimento) prefill.empreendimento = empreendimento;

  return ok(
    {
      ...outcome.result,
      title:
        contact?.display_name?.trim() ||
        contact?.name?.trim() ||
        contact?.phone_number?.trim() ||
        "",
      description: triagem?.resumo ?? null,
      prefill,
      contact: {
        id: contactId,
        display_name: contact?.display_name ?? null,
        name: contact?.name ?? null,
        phone_number: contact?.phone_number ?? null,
      },
    },
    { requestId },
  );
}
