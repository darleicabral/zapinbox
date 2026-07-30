/**
 * POST /api/v1/contacts/bulk-delete — apaga vários contatos de uma vez.
 *
 * Serve pra limpar importação errada de planilha (pedido do Darlei, 30/07), NÃO
 * pra "esquecer" cliente: pra isso existe a anonimização LGPD, que preserva o
 * histórico. Daí a regra central desta rota:
 *
 * **só apaga contato SEM histórico.** Motivo é o próprio schema:
 *  - `conversations.contact_id` e `messages.contact_id` são ON DELETE **RESTRICT**
 *    → o Postgres recusaria o DELETE (23503) e o lote inteiro morreria;
 *  - `crm_leads.contact_id` é ON DELETE **SET NULL** → apagar o contato deixaria
 *    o atendimento órfão, sem cliente, sem ninguém perceber. Pior que recusar.
 *
 * Então: quem tem conversa, mensagem ou atendimento volta em `skipped` com o
 * motivo em português, e a tela mostra. Nível mínimo: **gerente** (a atendente
 * não apaga cliente em lote).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { canManageTeam } from "@/lib/auth/permissions";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { contactsBulkDeleteSchema, validateRequest } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface SkippedItem {
  id: string;
  name: string;
  reason: string;
}

/** Nome pra mostrar na tela quando o contato é recusado. */
function nameOf(c: { name: string | null; display_name: string | null }): string {
  return c.display_name?.trim() || c.name?.trim() || "sem nome";
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const supabase = await createClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) return fail("unauthenticated", "Auth required.", 401, { requestId });

  const authUser = await loadAuthUser();
  const activeOrg = authUser ? await resolveActiveOrg(authUser) : null;
  if (!activeOrg) return fail("no_active_org", "No active organization.", 403, { requestId });
  if (!canManageTeam(activeOrg.role)) {
    return fail("forbidden_role", "Apenas gerentes e admins podem apagar contatos.", 403, {
      requestId,
    });
  }

  let input;
  try {
    input = await validateRequest(contactsBulkDeleteSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  const ids = Array.from(new Set(input.ids));

  // RLS já limita à org ativa; o filtro explícito evita apagar de outro tenant
  // caso o usuário seja membro de vários.
  const { data: found, error: findErr } = await supabase
    .from("contacts")
    .select("id, name, display_name")
    .eq("organization_id", activeOrg.orgId)
    .in("id", ids);
  if (findErr) return fail("internal_error", findErr.message, 500, { requestId });

  const contacts = (found ?? []) as { id: string; name: string | null; display_name: string | null }[];
  const byId = new Map(contacts.map((c) => [c.id, c]));

  // Uma consulta por tabela dependente (não uma por contato).
  const [convs, msgs, leads] = await Promise.all([
    supabase.from("conversations").select("contact_id").in("contact_id", ids),
    supabase.from("messages").select("contact_id").in("contact_id", ids),
    supabase.from("crm_leads").select("contact_id").in("contact_id", ids),
  ]);
  const firstErr = convs.error ?? msgs.error ?? leads.error;
  if (firstErr) return fail("internal_error", firstErr.message, 500, { requestId });

  const setOf = (rows: { contact_id: string | null }[] | null) =>
    new Set((rows ?? []).map((r) => r.contact_id).filter((v): v is string => !!v));
  const withConv = setOf(convs.data as { contact_id: string | null }[] | null);
  const withMsg = setOf(msgs.data as { contact_id: string | null }[] | null);
  const withLead = setOf(leads.data as { contact_id: string | null }[] | null);

  const skipped: SkippedItem[] = [];
  const deletable: string[] = [];

  for (const id of ids) {
    const c = byId.get(id);
    if (!c) {
      skipped.push({ id, name: "—", reason: "não encontrado" });
      continue;
    }
    // Ordem dos motivos = da consequência mais visível pra menos.
    if (withLead.has(id)) skipped.push({ id, name: nameOf(c), reason: "tem atendimento" });
    else if (withConv.has(id)) skipped.push({ id, name: nameOf(c), reason: "tem conversa" });
    else if (withMsg.has(id)) skipped.push({ id, name: nameOf(c), reason: "tem mensagem" });
    else deletable.push(id);
  }

  let deleted: string[] = [];
  if (deletable.length > 0) {
    const { data: gone, error: delErr } = await supabase
      .from("contacts")
      .delete()
      .eq("organization_id", activeOrg.orgId)
      .in("id", deletable)
      .select("id");
    if (delErr) {
      // 23503: apareceu histórico entre a checagem e o DELETE (mensagem nova
      // chegando no meio, por exemplo). Não é erro do usuário.
      if (delErr.code === "23503") {
        for (const id of deletable) {
          const c = byId.get(id);
          skipped.push({ id, name: c ? nameOf(c) : "—", reason: "ganhou histórico agora" });
        }
      } else {
        return fail("internal_error", delErr.message, 500, { requestId });
      }
    } else {
      deleted = ((gone ?? []) as { id: string }[]).map((r) => r.id);
    }
  }

  if (deleted.length > 0) {
    await audit({
      action: "contact.bulk_deleted",
      actorUserId: user.id,
      organizationId: activeOrg.orgId,
      resourceType: "contact",
      requestId,
      metadata: {
        deleted_count: deleted.length,
        deleted_ids: deleted,
        // nomes ajudam a reconstruir o que foi apagado sem o registro existir
        deleted_names: deleted.map((id) => (byId.has(id) ? nameOf(byId.get(id)!) : "—")),
        skipped_count: skipped.length,
      },
    });
  }

  return ok({ deleted, skipped }, { requestId });
}
