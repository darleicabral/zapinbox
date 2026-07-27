/**
 * POST /api/v1/conversations/[id]/open-lead — abre um ATENDIMENTO a partir da
 * conversa (decisão Itaville 22/07: a abertura é MANUAL; a atendente decide
 * quem vira atendimento).
 *
 * Aqui fica só o que é específico da conversa (título pelo contato + prefill da
 * triagem da IA). A regra de negócio — pipeline default, reincidente, 1ª etapa,
 * insert, event, audit — vive em `lib/leads/open-lead.ts`, compartilhada com a
 * abertura pela lista de Contatos.
 *
 * Client de SESSÃO (RLS): o ator é membro da org.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { openLeadForContact } from "@/lib/leads/open-lead";
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
      "id, organization_id, contact_id, metadata, contacts:contact_id(display_name, name, phone_number)",
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
      } | null;
    }
  ).contacts;
  const title =
    contact?.display_name?.trim() ||
    contact?.name?.trim() ||
    contact?.phone_number?.trim() ||
    "Atendimento WhatsApp";

  // Pré-preenchimento a partir da sinalização da IA (metadata.triagem) — editável
  // depois pela atendente. Só entra no atendimento NOVO (o reincidente não é tocado).
  const triagem = ((conv as { metadata: Record<string, unknown> | null }).metadata?.triagem ??
    null) as {
    categoria_sugerida?: string;
    nivel_sugerido?: string;
    resumo?: string;
  } | null;
  const prefill: Record<string, unknown> = { canal: "WhatsApp" };
  if (triagem?.categoria_sugerida) prefill.categoria = triagem.categoria_sugerida;
  if (triagem?.nivel_sugerido) prefill.nivel_acompanhamento = triagem.nivel_sugerido;

  const outcome = await openLeadForContact(supabase, {
    orgId,
    contactId,
    actorUserId: user.id,
    requestId,
    title,
    prefill,
    description: triagem?.resumo ?? null,
    origin: { from_conversation: conversationId },
  });

  if (!outcome.ok) {
    return fail(outcome.code, outcome.message, outcome.status, { requestId });
  }
  return ok(outcome.result, { requestId });
}
