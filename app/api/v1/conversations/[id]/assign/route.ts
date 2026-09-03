/**
 * POST /api/v1/conversations/[id]/assign  body: { user_id }
 *
 * Atribuição MANUAL: o gestor escolhe o corretor, e o corretor recebe no
 * WhatsApp o mesmo aviso rico do rodízio automático (nome do lead, link pra
 * falar com ele, resumo da IA, imóvel de interesse).
 *
 * Pedido do Darlei (03/09/2026): "assim consigo enviar notificação para os
 * corretores mesmo com os leads parados no sistema" — o rodízio só age em
 * conversa nova, e o acervo parado ficava sem ninguém.
 *
 * Diferente do /claim, que é "eu assumo". Aqui se escolhe OUTRA pessoa, e por
 * isso o alvo é validado: tem de ser membro ativo com papel de atendimento
 * (agent ou manager). Admin fica fora de propósito — "o dono não é corretor"
 * (Darlei, 03/09/2026); pra assumir você mesmo existe o botão Assumir.
 *
 * Não silencia o bot, igual ao /claim: quem impede o bot de falar por cima do
 * humano é a janela de `humanIsHandling` no dispatcher.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { notifyAssigneeNewLead } from "@/lib/attendance/notify";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { validateRequest } from "@/lib/schemas";
import type { Conversation } from "@/lib/types/messaging";

export const dynamic = "force-dynamic";

const SELECT_COLS = `
  id, organization_id, contact_id, channel_session_id, channel, status,
  status_changed_at, assigned_to_user_id, assigned_at, last_inbound_at,
  last_outbound_at, last_message_at, last_message_preview,
  unread_count_for_assignee, is_group, group_chat_id, metadata,
  created_at, updated_at
`;

/** Papéis que atendem lead. Admin não entra (ver cabeçalho). */
const PAPEIS_QUE_ATENDEM = ["agent", "manager"];

const assignSchema = z.object({
  user_id: z.string().uuid("user_id deve ser um UUID."),
});

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  const supabase = await createClient();

  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }

  let input;
  try {
    input = await validateRequest(assignSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  // A conversa vem pelo client de SESSÃO: o RLS já garante que o caller é da org.
  const { data: antes, error: convErr } = await supabase
    .from("conversations")
    .select("id, organization_id, assigned_to_user_id")
    .eq("id", id)
    .maybeSingle();
  if (convErr) return fail("internal_error", convErr.message, 500, { requestId });
  if (!antes) return fail("not_found", "Conversa não encontrada.", 404, { requestId });

  const orgId = (antes as { organization_id: string }).organization_id;
  const donoAnterior = (antes as { assigned_to_user_id: string | null }).assigned_to_user_id;

  // Alvo precisa ser membro ATIVO e atender lead.
  const { data: membro, error: membroErr } = await supabase
    .from("user_organizations")
    .select("user_id, role")
    .eq("organization_id", orgId)
    .eq("user_id", input.user_id)
    .is("revoked_at", null)
    .maybeSingle();
  if (membroErr) return fail("internal_error", membroErr.message, 500, { requestId });
  if (!membro) {
    return fail("invalid_request", "Esse usuário não é da equipe.", 422, { requestId });
  }
  if (!PAPEIS_QUE_ATENDEM.includes((membro as { role: string }).role)) {
    return fail(
      "invalid_request",
      "Só dá pra atribuir a corretor ou gerente. Pra assumir você mesmo, use Assumir.",
      422,
      { requestId },
    );
  }

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("conversations")
    .update({
      assigned_to_user_id: input.user_id,
      assigned_at: now,
      status: "claimed",
      status_changed_at: now,
    })
    .eq("id", id)
    .select(SELECT_COLS)
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!data) return fail("not_found", "Conversa não encontrada.", 404, { requestId });

  const conv = data as unknown as Conversation;

  await audit({
    action: "conversation.assigned",
    actorUserId: user.id,
    organizationId: orgId,
    resourceType: "conversation",
    resourceId: conv.id,
    requestId,
    metadata: { assigned_to_user_id: input.user_id, previous_assignee: donoAnterior },
  });

  await supabase
    .rpc("emit_event", {
      p_event_type: "conversation.assigned",
      p_entity_kind: "conversation",
      p_entity_id: conv.id,
      p_payload: { assigned_to_user_id: input.user_id, assigned_by: user.id },
      p_metadata: { request_id: requestId },
      p_organization_id: orgId,
    })
    .then(({ error: emitErr }) => {
      if (emitErr) console.error("[conversation.assign] emit_event failed", emitErr.message);
    });

  // Aviso no WhatsApp do corretor. Client ADMIN: a notificação lê contato,
  // lead e imóvel e manda pelo WAHA — fora do alcance do RLS do caller.
  // Se o aviso falhar, a atribuição continua valendo (o corretor vê no CRM).
  const avisou = await notifyAssigneeNewLead(createAdminClient(), {
    organizationId: orgId,
    conversationId: conv.id,
    assigneeUserId: input.user_id,
    kind: donoAnterior && donoAnterior !== input.user_id ? "reassigned" : "assigned",
  });

  return ok({ ...conv, notified: avisou }, { requestId });
}
