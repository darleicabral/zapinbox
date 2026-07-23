import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Ao RESOLVER (won) um atendimento, fecha a(s) conversa(s) aberta(s) do mesmo
 * contato no Inbox — decisão Itaville (22/07): mover o card p/ "Resolvido"
 * já fecha a conversa no WhatsApp/Inbox.
 *
 * Best-effort: se falhar, NÃO derruba a resolução do lead (o fechamento da
 * conversa é um efeito colateral desejável, não crítico). O vínculo é o
 * `contact_id` (não há FK lead↔conversa neste fork), então fechamos as
 * conversas não-encerradas do contato. Para o piloto Itaville (1 contato =
 * 1 conversa de WhatsApp) isso é exato; genérico o bastante p/ outros tenants.
 *
 * Chamado com o client de SESSÃO (RLS): o ator é membro da org e pode fechar
 * conversas dela. NÃO reabre se o lead voltar de etapa (decisão: só fecha).
 */
export async function closeConversationsForResolvedLead(
  supabase: SupabaseClient,
  orgId: string,
  contactId: string | null,
): Promise<void> {
  if (!contactId) return;
  const { error } = await supabase
    .from("conversations")
    .update({ status: "closed", status_changed_at: new Date().toISOString() })
    .eq("organization_id", orgId)
    .eq("contact_id", contactId)
    .not("status", "in", "(closed,archived)");
  if (error) {
    console.error("[close-on-resolve] falha ao fechar conversa do contato", error.message);
  }
}
