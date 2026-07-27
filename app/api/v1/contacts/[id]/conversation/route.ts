/**
 * POST /api/v1/contacts/[id]/conversation — resolve a conversa de WhatsApp do
 * contato para o botão "WhatsApp" da lista de Contatos.
 *
 * Devolve a conversa existente (preferindo a que não está fechada) ou cria uma
 * nova, vazia, no número conectado da org — a atendente escreve a 1ª mensagem
 * pelo Inbox, dentro do nosso módulo (nada de wa.me).
 *
 * Client de SESSÃO (RLS): o insert passa pela policy de isolamento por org.
 * A unique parcial `uniq_conversations_1to1_per_contact_session` (migration
 * 0027) protege contra corrida — em 23505 relemos a conversa vencedora.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

interface ConversationRow {
  id: string;
  status: string;
  last_message_at: string | null;
}

/** Conversa "de trabalho": a mais recente que não está fechada; senão a mais recente. */
function pickConversation(rows: ConversationRow[]): ConversationRow | null {
  if (rows.length === 0) return null;
  const byRecency = [...rows].sort((a, b) =>
    (b.last_message_at ?? "").localeCompare(a.last_message_at ?? ""),
  );
  return byRecency.find((c) => c.status !== "closed" && c.status !== "archived") ?? byRecency[0]!;
}

export async function POST(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id: contactId } = await ctx.params;
  const supabase = await createClient();

  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) return fail("unauthenticated", "Auth required.", 401, { requestId });

  const { data: contact, error: contactErr } = await supabase
    .from("contacts")
    .select("id, organization_id, phone_number, wa_identity, is_blocked, is_anonymized")
    .eq("id", contactId)
    .maybeSingle();
  if (contactErr) return fail("internal_error", contactErr.message, 500, { requestId });
  if (!contact) return fail("not_found", "Contato não encontrado.", 404, { requestId });

  const c = contact as {
    organization_id: string;
    phone_number: string | null;
    wa_identity: string | null;
    is_blocked: boolean;
    is_anonymized: boolean;
  };
  if (c.is_anonymized) {
    return fail("lgpd_anonymization_irreversible", "Contato anonimizado (LGPD).", 403, {
      requestId,
    });
  }
  if (c.is_blocked) {
    return fail("contact_blocked", "Contato bloqueado — envio desabilitado.", 422, { requestId });
  }
  if (!c.phone_number && !c.wa_identity) {
    return fail(
      "contact_without_phone",
      "Contato sem telefone — não dá pra abrir o WhatsApp.",
      422,
      {
        requestId,
      },
    );
  }

  const { data: existingRows, error: convErr } = await supabase
    .from("conversations")
    .select("id, status, last_message_at")
    .eq("organization_id", c.organization_id)
    .eq("contact_id", contactId)
    .eq("is_group", false)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(20);
  if (convErr) return fail("internal_error", convErr.message, 500, { requestId });

  const existing = pickConversation((existingRows ?? []) as ConversationRow[]);
  if (existing) {
    return ok({ conversation_id: existing.id, created: false }, { requestId });
  }

  // Sem conversa ainda: precisa de um número conectado para pendurar a conversa.
  const { data: session } = await supabase
    .from("channel_sessions")
    .select("id, status")
    .eq("organization_id", c.organization_id)
    .eq("status", "WORKING")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!session) {
    return fail(
      "no_working_channel",
      "Nenhum número de WhatsApp conectado. Conecte em Conexões e tente de novo.",
      422,
      { requestId },
    );
  }

  const { data: created, error: insErr } = await supabase
    .from("conversations")
    .insert({
      organization_id: c.organization_id,
      contact_id: contactId,
      channel_session_id: (session as { id: string }).id,
      channel: "whatsapp",
      status: "open",
      is_group: false,
      unread_count_for_assignee: 0,
      // Sem isto a conversa nasce com last_message_at NULL e cai pro FIM da
      // lista do Inbox (ordenada por última mensagem, nulls por último) — a
      // atendente clicaria em "WhatsApp" e não acharia a conversa aberta.
      last_message_at: new Date().toISOString(),
      metadata: { opened_from: "contacts" },
    })
    .select("id")
    .single();

  if (insErr) {
    // 23505 = outra aba/atendente criou a mesma conversa no meio do caminho.
    if (insErr.code === "23505") {
      const { data: raced } = await supabase
        .from("conversations")
        .select("id, status, last_message_at")
        .eq("organization_id", c.organization_id)
        .eq("contact_id", contactId)
        .eq("is_group", false)
        .limit(20);
      const winner = pickConversation((raced ?? []) as ConversationRow[]);
      if (winner) return ok({ conversation_id: winner.id, created: false }, { requestId });
    }
    return fail("internal_error", insErr.message, 500, { requestId });
  }

  return ok({ conversation_id: (created as { id: string }).id, created: true }, { requestId });
}
