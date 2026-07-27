/**
 * POST /api/v1/contacts/[id]/open-lead — abre um ATENDIMENTO já vinculado ao
 * contato, direto da lista de Contatos (botão "Abrir atendimento").
 *
 * Mesma regra da abertura pelo Inbox (pipeline default, dedupe de reincidente,
 * 1ª etapa aberta) — ver `lib/leads/open-lead.ts`. O que muda é o prefill: aqui
 * vem do cadastro do contato (empreendimento) e o canal é Telefone, porque esta
 * porta é a abordagem ativa (a atendente ligando), não uma conversa recebida.
 *
 * Client de SESSÃO (RLS): o ator é membro da org.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { CONTACT_FIELD, contactFieldText } from "@/lib/contacts/fields";
import { openLeadForContact } from "@/lib/leads/open-lead";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
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
    .select("id, organization_id, display_name, name, phone_number, is_anonymized, custom_fields")
    .eq("id", contactId)
    .maybeSingle();
  if (contactErr) return fail("internal_error", contactErr.message, 500, { requestId });
  if (!contact) return fail("not_found", "Contato não encontrado.", 404, { requestId });

  const c = contact as {
    organization_id: string;
    display_name: string | null;
    name: string | null;
    phone_number: string | null;
    is_anonymized: boolean;
    custom_fields: Record<string, unknown> | null;
  };
  if (c.is_anonymized) {
    return fail("lgpd_anonymization_irreversible", "Contato anonimizado (LGPD).", 403, {
      requestId,
    });
  }

  const title = c.display_name?.trim() || c.name?.trim() || c.phone_number?.trim() || "Atendimento";

  const prefill: Record<string, unknown> = { canal: "Telefone" };
  const empreendimento = contactFieldText(c.custom_fields, CONTACT_FIELD.empreendimento);
  if (empreendimento) prefill.empreendimento = empreendimento;

  const outcome = await openLeadForContact(supabase, {
    orgId: c.organization_id,
    contactId,
    actorUserId: user.id,
    requestId,
    title,
    prefill,
    origin: { from_contact: contactId },
  });

  if (!outcome.ok) {
    return fail(outcome.code, outcome.message, outcome.status, { requestId });
  }
  return ok(outcome.result, { requestId });
}
