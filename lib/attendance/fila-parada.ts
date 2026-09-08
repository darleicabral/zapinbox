/**
 * A fila de lead SEM CORRETOR — o que o resgate automático não pega.
 *
 * `parados.ts` resgata sozinho quando a bola está COM A GENTE (o lead falou por
 * último e ninguém respondeu). Mas existe uma segunda pilha, maior e mais
 * silenciosa: o bot conversou, respondeu por último, o lead não voltou, e
 * NENHUM corretor jamais soube que aquele lead existiu.
 *
 * Medido na Avant em 08/09/2026: 88 conversas sem dono, das quais só 2 tinham a
 * bola com a gente. Outras 46 eram lead dos últimos 7 dias com duas ou mais
 * mensagens — gente que conversou de verdade, inclusive uma com visita marcada.
 *
 * Essa pilha NÃO pode ser distribuída automaticamente: são dezenas de avisos de
 * uma vez, e ligar tempo sobre acervo parado já causou 116 mensagens em 5
 * minutos em 01/09. Então aqui a gente só LISTA, e quem decide é o gestor, na
 * tela, escolhendo quem vai pra quem.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** Só lead que conversou de verdade; 1 mensagem sozinha é quem abriu e sumiu. */
export const MIN_MENSAGENS_DO_LEAD = 2;

export interface LeadSemCorretor {
  conversationId: string;
  contactId: string;
  nome: string;
  telefone: string;
  mensagensDoLead: number;
  /** Última coisa que o lead escreveu, cortada pra caber na tela. */
  ultimaFala: string;
  ultimaEntradaEm: string;
  /** true = o lead está esperando resposta (bola com a gente). */
  leadEsperando: boolean;
}

interface ContatoLinha {
  id: string;
  name: string | null;
  display_name: string | null;
  phone_number: string | null;
  is_internal: boolean | null;
  is_blocked: boolean | null;
}

interface ConvLinha {
  id: string;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  contacts: ContatoLinha | ContatoLinha[] | null;
}

function um(c: ConvLinha["contacts"]): ContatoLinha | null {
  return Array.isArray(c) ? (c[0] ?? null) : c;
}

/**
 * Conversas sem dono com lead que conversou, nos últimos `dias`.
 *
 * O client é o de SESSÃO: a RLS isola a org, e `organization_id` explícito é
 * cinto de segurança. Ordena pelo lead que falou mais recentemente — quem
 * conversou agora esfria mais rápido que quem conversou anteontem.
 */
export async function listarLeadsSemCorretor(
  client: SupabaseClient,
  organizationId: string,
  opts: { dias?: number; limite?: number } = {},
): Promise<LeadSemCorretor[]> {
  const dias = opts.dias ?? 7;
  const limite = opts.limite ?? 100;
  const desde = new Date(Date.now() - dias * 24 * 60 * 60_000).toISOString();

  const { data, error } = await client
    .from("conversations")
    .select(
      "id, last_inbound_at, last_outbound_at, contacts:contact_id (id, name, display_name, phone_number, is_internal, is_blocked)",
    )
    .eq("organization_id", organizationId)
    .is("assigned_to_user_id", null)
    .not("last_inbound_at", "is", null)
    .gte("last_inbound_at", desde)
    .neq("status", "closed")
    .order("last_inbound_at", { ascending: false })
    .limit(400);
  if (error) throw new Error(error.message);

  const candidatas = ((data ?? []) as unknown as ConvLinha[]).filter((c) => {
    const k = um(c.contacts);
    // Sem telefone ninguém atende; interno é o próprio corretor; bloqueado
    // pediu descadastro.
    return Boolean(k?.phone_number) && !k?.is_internal && !k?.is_blocked;
  });
  if (candidatas.length === 0) return [];

  // Uma query pra todas as conversas: contar mensagem por conversa numa varredura
  // só, em vez de N+1 (eram 88 conversas na Avant).
  const ids = candidatas.map((c) => c.id);
  const { data: msgs } = await client
    .from("messages")
    .select("conversation_id, body, created_at")
    .eq("organization_id", organizationId)
    .eq("direction", "inbound")
    .in("conversation_id", ids)
    .order("created_at", { ascending: false })
    .limit(4000);

  const porConversa = new Map<string, { total: number; ultima: string }>();
  for (const m of (msgs ?? []) as { conversation_id: string; body: string | null }[]) {
    const atual = porConversa.get(m.conversation_id);
    if (atual) atual.total += 1;
    // A primeira que aparece é a mais recente (ordem desc).
    else porConversa.set(m.conversation_id, { total: 1, ultima: (m.body ?? "").trim() });
  }

  const saida: LeadSemCorretor[] = [];
  for (const c of candidatas) {
    const k = um(c.contacts)!;
    const agg = porConversa.get(c.id);
    if (!agg || agg.total < MIN_MENSAGENS_DO_LEAD) continue;
    saida.push({
      conversationId: c.id,
      contactId: k.id,
      // `name` primeiro: é o que alguém digitou. display_name vem do push name
      // do WhatsApp, que às vezes é emoji ou apelido.
      nome: k.name?.trim() || k.display_name?.trim() || k.phone_number!,
      telefone: k.phone_number!,
      mensagensDoLead: agg.total,
      ultimaFala: agg.ultima.length > 160 ? `${agg.ultima.slice(0, 160)}…` : agg.ultima,
      ultimaEntradaEm: c.last_inbound_at!,
      leadEsperando:
        !c.last_outbound_at ||
        new Date(c.last_outbound_at).getTime() < new Date(c.last_inbound_at!).getTime(),
    });
  }
  return saida.slice(0, limite);
}
