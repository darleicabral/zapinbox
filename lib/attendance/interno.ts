/**
 * lib/attendance/interno.ts — quem é da EQUIPE não é lead.
 *
 * Contexto (03/09/2026): o aviso de lead vai pro WhatsApp do corretor, o WAHA
 * devolve o eco (fromMe) e o ingest cria contato + conversa com o próprio
 * corretor. A conversa nasce `pending`, o vigia de SLA a trata como lead,
 * atribui pra outro corretor e manda aviso novo — laço. O número do Cleber
 * estava listado como lead no inbox da Avant.
 *
 * Decisão do Darlei: marcar como interna. A conversa fica (o rastro do aviso
 * importa), mas sai do inbox, do SLA, do follow-up e do bot.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

/** Só os dígitos, ou null se não sobrar nada aproveitável. */
export function digitosDeTelefone(valor: string | null | undefined): string | null {
  const d = (valor ?? "").replace(/\D/g, "");
  return d.length >= 10 && d.length <= 15 ? d : null;
}

/**
 * As formas em que o MESMO número pode aparecer, por causa do nono dígito.
 *
 * O telefone de aviso é digitado no formato novo (+5531992831280) e o contato
 * nasce do JID real do WhatsApp, que em conta anterior a 2012 vem sem o 9
 * (553192831280). Comparar só uma forma não casa nada.
 */
export function variantesDeTelefone(valor: string | null | undefined): string[] {
  const d = digitosDeTelefone(valor);
  if (!d) return [];
  const fora: string[] = [d];
  // 55 + DDD + 9XXXXXXXX  ->  55 + DDD + XXXXXXXX
  if (d.length === 13 && d[4] === "9") fora.push(d.slice(0, 4) + d.slice(5));
  // e o contrário, pra quem cadastrou no formato antigo
  if (d.length === 12) fora.push(`${d.slice(0, 4)}9${d.slice(4)}`);
  return [...new Set(fora)];
}

export function ehTelefoneDaEquipe(
  telefoneDoContato: string | null | undefined,
  digitosDaEquipe: Set<string>,
): boolean {
  if (digitosDaEquipe.size === 0) return false;
  return variantesDeTelefone(telefoneDoContato).some((v) => digitosDaEquipe.has(v));
}

/** Todos os telefones de aviso da org, nas duas formas. Uma query por passada. */
export async function carregarTelefonesDaEquipe(
  client: SupabaseClient,
  organizationId: string,
): Promise<Set<string>> {
  const { data, error } = await client
    .from("user_organizations")
    .select("notify_whatsapp_e164")
    .eq("organization_id", organizationId)
    .is("revoked_at", null)
    .not("notify_whatsapp_e164", "is", null);
  if (error) {
    logger.warn("[interno] não consegui ler os telefones da equipe", {
      organization_id: organizationId,
      erro: error.message,
    });
    return new Set();
  }
  const fora = new Set<string>();
  for (const linha of (data ?? []) as { notify_whatsapp_e164: string | null }[]) {
    for (const v of variantesDeTelefone(linha.notify_whatsapp_e164)) fora.add(v);
  }
  return fora;
}

/** Marca o contato como interno. Falha aqui não pode derrubar o worker. */
export async function marcarContatoInterno(
  client: SupabaseClient,
  organizationId: string,
  contactId: string,
): Promise<void> {
  const { error } = await client
    .from("contacts")
    .update({ is_internal: true, updated_at: new Date().toISOString() })
    .eq("id", contactId)
    .eq("organization_id", organizationId);
  if (error) {
    logger.warn("[interno] não consegui marcar o contato", {
      organization_id: organizationId,
      contact_id: contactId,
      erro: error.message,
    });
    return;
  }
  logger.info("[interno] contato da equipe marcado como interno", {
    organization_id: organizationId,
    contact_id: contactId,
  });
}
