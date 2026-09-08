/**
 * Resgate de lead PARADO — a rede que pega o que o bot não encaminhou.
 *
 * O rodízio de `sla.ts` só olha conversa `status = 'pending'`, e só o handoff do
 * bot põe conversa em `pending`. Consequência: quando o bot NÃO encaminha — por
 * decisão errada, por falha de provider, por sessão do WhatsApp caída, por
 * contato bloqueado — a conversa fica em `open` sem dono e nenhum corretor
 * jamais sabe que existe. O lead simplesmente para ali.
 *
 * Foi assim que dois leads ficaram esquecidos em 08/09/2026 (bloqueados por
 * engano pela palavra "sair" no meio da frase), um deles desde 01/09 pedindo pra
 * remarcar visita.
 *
 * O CRITÉRIO é "a bola está com a gente": a última mensagem da conversa é do
 * LEAD. Não importa por que o bot calou — se ele escreveu e ninguém respondeu
 * depois do prazo, um corretor recebe. Isso cobre qualquer falha futura sem
 * precisar prever a causa, que é a lição do apagão de 06–08/09.
 *
 * ⚠️ Por que os limites existem: em 01/09 ligar tempo sobre o acervo parado
 * gerou 116 mensagens em 5 minutos. Aqui cada resgate ACORDA UM CORRETOR no
 * WhatsApp dele, então:
 *   - só dentro do expediente (quem chama isso é o sweep, que já garante);
 *   - só lead esperando há mais de `ESPERA_MIN` (o bot merece a chance de agir);
 *   - só conversa ativa nos últimos `IDADE_MAX_DIAS` (não se ressuscita acervo);
 *   - no máximo `TETO_POR_TICK` por passada;
 *   - conversa que já tem dono nunca é tocada (o lead nunca passa adiante).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { motivoDoLeadParaEncaminhar } from "@/lib/ai/runtime/handoff";
import { splitSenderPrefix } from "@/lib/ai/runtime/history";
import { listAuthUsersByIds } from "@/lib/auth/admin-users";

import { carregarTelefonesDaEquipe, ehTelefoneDaEquipe, marcarContatoInterno } from "./interno";
import { notifyAssigneeNewLead } from "./notify";
import { pickNextAssignee } from "./rotation";

/** O bot responde em segundos; 15 min de silêncio é falha, não demora. */
export const ESPERA_MIN = 15;
/** Acima disso é acervo: resgatar em massa vira spam, e o Darlei decide à mão. */
export const IDADE_MAX_DIAS = 7;
/** Cada resgate acorda um corretor. Fila grande escoa em vários ticks. */
export const TETO_POR_TICK = 10;

export interface ResgateSummary {
  candidatos: number;
  resgatados: number;
  sem_corretor: number;
  /** Voltaram pro corretor que já falava com o lead, sem passar pelo rodízio. */
  devolvidos_a_quem_atendia: number;
}

/** Sem acento e em minúscula, pra comparar "Cléber" com "cleber". */
function chaveDeNome(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Mn}/gu, "")
    .trim()
    .toLowerCase();
}

/**
 * Primeiro nome que aparece no prefixo "*Nome:*" das saídas humanas, da mais
 * recente pra trás. É a convenção que o corretor usa ao escrever pelo aparelho
 * dele no número compartilhado, e a mesma que `splitSenderPrefix` já entende.
 */
export function nomeDoCorretorNaConversa(corpos: (string | null)[]): string | null {
  for (const corpo of corpos) {
    const { sender } = splitSenderPrefix((corpo ?? "").trim());
    if (sender) {
      const primeiro = sender.split(/\s+/)[0] ?? "";
      if (primeiro.length >= 2) return primeiro;
    }
  }
  return null;
}

/**
 * Casa o nome do prefixo com um membro da equipe. Só devolve quando é
 * INEQUÍVOCO: dois "Marcos" na equipe e o resgate volta pro rodízio, porque
 * chutar entre eles é pior que sortear.
 */
export function casarNomeComMembro(
  nome: string | null,
  membros: { user_id: string; primeiro_nome: string | null }[],
): string | null {
  if (!nome) return null;
  const alvo = chaveDeNome(nome);
  const casam = membros.filter((m) => m.primeiro_nome && chaveDeNome(m.primeiro_nome) === alvo);
  return casam.length === 1 ? casam[0]!.user_id : null;
}

/**
 * O corretor que já falou nesta conversa pelo próprio aparelho, se der pra
 * saber com certeza quem foi. Qualquer dúvida devolve null e o rodízio decide.
 */
async function corretorQueJaAtendeu(
  admin: SupabaseClient,
  organizationId: string,
  conversationId: string,
): Promise<string | null> {
  const { data: saidas } = await admin
    .from("messages")
    .select("body, sent_via")
    .eq("organization_id", organizationId)
    .eq("conversation_id", conversationId)
    .eq("direction", "outbound")
    .in("sent_via", ["external_device", "user"])
    .order("created_at", { ascending: false })
    .limit(10);
  const corpos = ((saidas ?? []) as { body: string | null }[]).map((m) => m.body);
  const nome = nomeDoCorretorNaConversa(corpos);
  if (!nome) return null;

  const { data: membros } = await admin
    .from("user_organizations")
    .select("user_id, role")
    .eq("organization_id", organizationId)
    .is("revoked_at", null)
    .in("role", ["agent", "manager"]); // admin (o Dono) nunca atende lead
  const ids = ((membros ?? []) as { user_id: string }[]).map((m) => m.user_id);
  if (ids.length === 0) return null;

  const usuarios = await listAuthUsersByIds(admin, ids);
  const comNome = usuarios.map((u) => {
    const meta = u.raw_user_meta_data ?? null;
    const full =
      (typeof meta?.full_name === "string" && meta.full_name) ||
      (typeof meta?.name === "string" && meta.name) ||
      "";
    return { user_id: u.id, primeiro_nome: full.trim().split(/\s+/)[0] || null };
  });
  return casarNomeComMembro(nome, comNome);
}

interface ContatoDoLead {
  id: string;
  phone_number: string | null;
  is_internal: boolean | null;
  is_blocked: boolean | null;
}

interface ConvParada {
  id: string;
  status: string;
  assigned_to_user_id: string | null;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  contacts: ContatoDoLead | ContatoDoLead[] | null;
}

function umContato(c: ConvParada["contacts"]): ContatoDoLead | null {
  return Array.isArray(c) ? (c[0] ?? null) : c;
}

/**
 * A bola está com a gente: o lead falou por último. Sem saída nenhuma também
 * conta — ele escreveu e nunca ouviu nada de volta, que é o caso pior.
 */
export function leadEstaEsperando(conv: {
  last_inbound_at: string | null;
  last_outbound_at: string | null;
}): boolean {
  if (!conv.last_inbound_at) return false;
  if (!conv.last_outbound_at) return true;
  return new Date(conv.last_outbound_at).getTime() < new Date(conv.last_inbound_at).getTime();
}

/** Espera do lead em minutos, ou null quando ele nunca escreveu. */
export function minutosEsperando(
  conv: { last_inbound_at: string | null },
  agora: Date,
): number | null {
  if (!conv.last_inbound_at) return null;
  return (agora.getTime() - new Date(conv.last_inbound_at).getTime()) / 60_000;
}

/** Está na janela de resgate: esperou o suficiente e não é acervo velho. */
export function estaNaJanelaDeResgate(
  conv: { last_inbound_at: string | null; last_outbound_at: string | null },
  agora: Date,
): boolean {
  if (!leadEstaEsperando(conv)) return false;
  const esperou = minutosEsperando(conv, agora);
  if (esperou === null) return false;
  return esperou >= ESPERA_MIN && esperou <= IDADE_MAX_DIAS * 24 * 60;
}

/**
 * Atribui e avisa os leads parados de UMA org. Chamado pelo sweep de
 * atendimento, que já filtrou expediente.
 */
export async function resgatarLeadsParados(
  admin: SupabaseClient,
  organizationId: string,
  opts: { now?: Date; teto?: number } = {},
): Promise<ResgateSummary> {
  const agora = opts.now ?? new Date();
  const teto = opts.teto ?? TETO_POR_TICK;
  const resumo: ResgateSummary = {
    candidatos: 0,
    resgatados: 0,
    sem_corretor: 0,
    devolvidos_a_quem_atendia: 0,
  };

  const desde = new Date(agora.getTime() - IDADE_MAX_DIAS * 24 * 60 * 60_000).toISOString();
  const ate = new Date(agora.getTime() - ESPERA_MIN * 60_000).toISOString();

  // O banco já descarta o óbvio: sem dono, com entrada do lead, dentro da
  // janela. O resto (bola de quem, contato interno) o código decide, porque
  // depende de comparar duas colunas e de uma lista carregada à parte.
  const { data, error } = await admin
    .from("conversations")
    .select(
      "id, status, assigned_to_user_id, last_inbound_at, last_outbound_at, contacts:contact_id (id, phone_number, is_internal, is_blocked)",
    )
    .eq("organization_id", organizationId)
    .is("assigned_to_user_id", null)
    .not("last_inbound_at", "is", null)
    .gte("last_inbound_at", desde)
    .lte("last_inbound_at", ate)
    .neq("status", "closed")
    .order("last_inbound_at", { ascending: true });
  if (error) throw new Error(`resgate_query: ${error.message}`);

  const telefonesDaEquipe = await carregarTelefonesDaEquipe(admin, organizationId);

  for (const conv of (data ?? []) as unknown as ConvParada[]) {
    if (resumo.resgatados >= teto) break;
    if (!estaNaJanelaDeResgate(conv, agora)) continue;

    const contato = umContato(conv.contacts);
    if (!contato) continue;
    // Conversa do próprio corretor não é lead (o aviso volta como eco).
    if (contato.is_internal) continue;
    if (ehTelefoneDaEquipe(contato.phone_number, telefonesDaEquipe)) {
      await marcarContatoInterno(admin, organizationId, contato.id);
      continue;
    }
    // Sem telefone ninguém consegue atender; bloqueado é pedido de descadastro.
    if (!contato.phone_number) continue;
    if (contato.is_blocked) continue;

    resumo.candidatos += 1;

    // Quem já estava atendendo tem preferência sobre o rodízio.
    //
    // "O lead nunca deve passar adiante" (Darlei, 04/09/2026). A Franciele, de
    // 01/09, é o caso exato: o Robson falou com ela pelo aparelho dele ("vou te
    // ligar as 17:30"), ela respondeu pedindo pra remarcar, e a conversa ficou
    // sem dono. Sortear outro corretor aqui seria tirar o lead do Robson.
    const jaAtendia = await corretorQueJaAtendeu(admin, organizationId, conv.id);
    const corretor = jaAtendia ?? (await pickNextAssignee(admin, organizationId, {}));
    if (!corretor) {
      resumo.sem_corretor += 1;
      break; // ninguém elegível agora: o próximo tick tenta de novo
    }
    if (jaAtendia) resumo.devolvidos_a_quem_atendia += 1;

    // CAS: só atribui se ainda estiver sem dono. Protege de corrida com o
    // handoff do bot e com a atribuição manual acontecendo no mesmo segundo.
    const { data: aplicado, error: upErr } = await admin
      .from("conversations")
      .update({
        assigned_to_user_id: corretor,
        assigned_at: agora.toISOString(),
        assignment_passes: 1,
      })
      .eq("id", conv.id)
      .eq("organization_id", organizationId)
      .is("assigned_to_user_id", null)
      .select("id")
      .maybeSingle();
    if (upErr || !aplicado) continue;

    // O recado do lead vale mais que a nossa leitura: se ele disse "só depois
    // das 19h" ou pediu o endereço, isso vai no aviso. As três últimas, porque
    // o recado costuma vir antes da última mensagem.
    const { data: ultimas } = await admin
      .from("messages")
      .select("body")
      .eq("organization_id", organizationId)
      .eq("conversation_id", conv.id)
      .eq("direction", "inbound")
      .order("created_at", { ascending: false })
      .limit(3);
    const recado =
      ((ultimas ?? []) as { body: string | null }[])
        .map((m) => motivoDoLeadParaEncaminhar(m.body ?? ""))
        .find((r) => r !== null) ?? null;

    try {
      await admin.rpc("emit_event" as never, {
        p_event_type: "attendance.rescued",
        p_entity_kind: "conversation",
        p_entity_id: conv.id,
        p_payload: {
          conversation_id: conv.id,
          to_user_id: corretor,
          esperando_min: Math.round(minutosEsperando(conv, agora) ?? 0),
        },
        p_metadata: { source: "attendance-parados" },
        p_organization_id: organizationId,
      } as never);
    } catch {
      /* event_log best-effort */
    }

    // AWAIT, nunca `void`: aviso solto em serverless morre com a função.
    await notifyAssigneeNewLead(admin, {
      organizationId,
      conversationId: conv.id,
      assigneeUserId: corretor,
      kind: "assigned",
      observacao: recado,
    });
    resumo.resgatados += 1;
  }

  return resumo;
}
