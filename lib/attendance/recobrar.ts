/**
 * Cobrar o corretor quando o lead volta a escrever e ele não respondeu.
 *
 * Pedido do Darlei (09/09/2026), item 5 da lista de melhorias. O caso real: a
 * Valone foi encaminhada ao Gilvam às 21h02 do dia 08 e voltou a escrever TRÊS
 * vezes na manhã seguinte — a última delas "Bom dia tenho interesse, só que não
 * me responde as mensagens". O bot fica calado depois do handoff (e é correto
 * que fique, senão fala por cima do corretor), a cadência para quando a conversa
 * tem dono, e ninguém cutuca o corretor. O lead some no vão.
 *
 * ⚠️ NÃO REATRIBUI, nunca. "O lead nunca deve passar adiante" e "a IA vai dizer
 * para o lead quem vai atender ele e isso não deve mudar" (Darlei, 04/09/2026).
 * O bot já falou o NOME do corretor pro cliente. Aqui a gente só bate na porta
 * do mesmo corretor de novo.
 *
 * 🐛 INCIDENTE, 09/09/2026 — a primeira versão disparou 29 COBRANÇAS na
 * primeira passada, de leads encaminhados havia até 6,3 dias, e o Cléber
 * reclamou. A premissa estava errada: "o lead voltou a escrever e o corretor
 * não respondeu no sistema" não mede nada, porque o corretor atende pelo
 * celular DELE, fora do número compartilhado. Ver a nota longa no laço.
 *
 * Os limites existem porque cada cobrança acorda uma pessoa:
 *   - o LEAD tem de estar RECLAMANDO (a única evidência que não depende de
 *     medir o corretor) — é o que derruba 29 para 1;
 *   - encaminhamento com mais de `IDADE_MAX_H` é acervo e não se cobra;
 *   - o corretor tem `CARENCIA_MIN` de sossego depois de receber o lead;
 *   - não cobra quem visivelmente já está atendendo por aqui;
 *   - uma cobrança por conversa a cada `SILENCIO_ENTRE_COBRANCAS_H`;
 *   - teto por passada, e só dentro do expediente (quem chama é o sweep).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { leadReclamouDeAbandono } from "@/lib/ai/runtime/handoff";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { resolveChatIdChecked, sendWAHA } from "@/lib/waha/send";

/** Sossego do corretor depois de receber o lead, antes de qualquer cobrança. */
export const CARENCIA_MIN = 30;
/** Não cobrar o mesmo corretor pela mesma conversa antes disso. */
export const SILENCIO_ENTRE_COBRANCAS_H = 6;
/**
 * Idade máxima do encaminhamento. Acima disso é acervo, e acervo não se cobra
 * em massa.
 *
 * 🐛 09/09/2026, poucas horas depois de subir isto: a primeira passada mandou
 * 29 COBRANÇAS, de leads encaminhados havia até 6,3 DIAS. O Cléber reclamou,
 * com razão. Faltavam as duas travas abaixo.
 */
export const IDADE_MAX_H = 48;
/** Cada cobrança acorda uma pessoa. Fila grande escoa em vários ticks. */
export const TETO_POR_TICK = 10;

export interface CobrancaSummary {
  cobrados: number;
  errors: string[];
}

interface ContatoDoLead {
  name: string | null;
  display_name: string | null;
  phone_number: string | null;
  is_internal: boolean | null;
}

interface ConvAtribuida {
  id: string;
  assigned_to_user_id: string;
  assigned_at: string;
  last_inbound_at: string | null;
  contacts: ContatoDoLead | ContatoDoLead[] | null;
}

function umContato(c: ConvAtribuida["contacts"]): ContatoDoLead | null {
  return Array.isArray(c) ? (c[0] ?? null) : c;
}

/**
 * "no dia 08/09 às 21h02" — quando o corretor recebeu o lead, no fuso da
 * operação. Precisa estar na mensagem: sem a data, o corretor não sabe se é
 * cobrança de um lead de hoje ou de anteontem.
 */
export function quandoEncaminhei(assignedAt: string, agora: Date): string {
  const emBrasilia = new Date(new Date(assignedAt).getTime() - 3 * 3_600_000);
  const dia = String(emBrasilia.getUTCDate()).padStart(2, "0");
  const mes = String(emBrasilia.getUTCMonth() + 1).padStart(2, "0");
  const hora = String(emBrasilia.getUTCHours()).padStart(2, "0");
  const min = String(emBrasilia.getUTCMinutes()).padStart(2, "0");
  const hojeBr = new Date(agora.getTime() - 3 * 3_600_000);
  const mesmoDia =
    hojeBr.getUTCDate() === emBrasilia.getUTCDate() &&
    hojeBr.getUTCMonth() === emBrasilia.getUTCMonth();
  return mesmoDia ? `hoje às ${hora}h${min}` : `no dia ${dia}/${mes} às ${hora}h${min}`;
}

/** A mensagem que chega no WhatsApp do corretor. Pura, pro texto ser testável. */
export function textoDaCobranca(args: {
  nomeDoLead: string;
  quando: string;
  waLink: string | null;
  crmLink: string;
}): string {
  const linhas = [
    `🔔 O lead *${args.nomeDoLead}* que te encaminhei ${args.quando} reclamou de não ter sido contatado.`,
  ];
  if (args.waLink) linhas.push("", `💬 Clique e converse: ${args.waLink}`);
  linhas.push("", `📲 Se precisar ver o histórico: ${args.crmLink}`);
  return linhas.join("\n");
}

/** Só dígitos, pro link wa.me. */
function digitos(phone: string | null): string | null {
  const d = (phone ?? "").replace(/\D/g, "");
  return d.length >= 10 ? d : null;
}

export async function cobrarCorretorSilencioso(
  admin: SupabaseClient,
  organizationId: string,
  opts: { now?: Date; teto?: number } = {},
): Promise<CobrancaSummary> {
  const agora = opts.now ?? new Date();
  const teto = opts.teto ?? TETO_POR_TICK;
  const resumo: CobrancaSummary = { cobrados: 0, errors: [] };

  const carenciaAte = new Date(agora.getTime() - CARENCIA_MIN * 60_000).toISOString();

  // Conversa COM dono, atribuída há mais que a carência, e com o lead tendo
  // escrito depois de ser encaminhado.
  const { data, error } = await admin
    .from("conversations")
    .select(
      "id, assigned_to_user_id, assigned_at, last_inbound_at, contacts:contact_id (name, display_name, phone_number, is_internal)",
    )
    .eq("organization_id", organizationId)
    .not("assigned_to_user_id", "is", null)
    .not("assigned_at", "is", null)
    .lte("assigned_at", carenciaAte)
    .not("last_inbound_at", "is", null)
    .neq("status", "closed")
    .order("last_inbound_at", { ascending: false })
    .limit(200);
  if (error) {
    resumo.errors.push(`cobranca_query: ${error.message}`);
    return resumo;
  }

  const sessionName = await sessaoWaha(admin, organizationId);

  for (const conv of (data ?? []) as unknown as ConvAtribuida[]) {
    if (resumo.cobrados >= teto) break;

    const contato = umContato(conv.contacts);
    if (!contato || contato.is_internal) continue;

    // O lead falou DEPOIS de ser encaminhado? Sem isso não há o que cobrar.
    if (new Date(conv.last_inbound_at!).getTime() <= new Date(conv.assigned_at).getTime()) {
      continue;
    }

    // Encaminhamento velho não se cobra: acima de IDADE_MAX_H é acervo.
    if (
      new Date(conv.assigned_at).getTime() <
      agora.getTime() - IDADE_MAX_H * 3_600_000
    ) {
      continue;
    }

    // ⚠️ SÓ COBRA SE O LEAD RECLAMOU DE VERDADE. Esta é a trava que faltava, e
    // ela é a diferença entre 1 cobrança e 29.
    //
    // A premissa errada da primeira versão era "o lead voltou a escrever e o
    // corretor não respondeu NO SISTEMA". Mas o corretor atende pelo WhatsApp
    // PESSOAL dele, por fora do número compartilhado — o CRM nunca vê essa
    // resposta, então a conversa fica "sem resposta" pra sempre e a cobrança
    // dispara em todo lead encaminhado. É o mesmo erro que o Darlei já tinha
    // corrigido em 08/09 sobre o alerta de SLA: "se o corretor atende pelo
    // celular dele, faz sentido alertar que o lead não foi atendido no
    // sistema?" — e a resposta foi não.
    //
    // A fala do LEAD é a única evidência que não depende de medir o corretor.
    // Se ele está escrevendo "ninguém me responde", ele não está sendo
    // atendido, independente do que aconteceu fora do nosso alcance. E é
    // exatamente o que a mensagem de cobrança afirma ("reclamou de não ter sido
    // contatado") — antes disso, a mensagem mentia sobre o próprio gatilho.
    //
    // Medido nas 29 que saíram por engano: exigindo reclamação sobra UMA, a
    // Valone, que é o caso que motivou o pedido.
    const { data: falasDoLead } = await admin
      .from("messages")
      .select("body")
      .eq("organization_id", organizationId)
      .eq("conversation_id", conv.id)
      .eq("direction", "inbound")
      .gt("sent_at", conv.assigned_at)
      .order("sent_at", { ascending: false })
      .limit(5);
    const reclamou = ((falasDoLead ?? []) as { body: string | null }[]).some((m) =>
      leadReclamouDeAbandono(m.body),
    );
    if (!reclamou) continue;

    // O corretor respondeu desde que recebeu? `external_device` é o celular
    // dele, `user` é o composer do CRM. Qualquer um dos dois encerra o assunto.
    // ⚠️ Isto NÃO prova que ele não falou com o lead (ver a nota acima): serve
    // só pra não cobrar quem visivelmente já está atendendo por aqui.
    const { count: falouAlgo } = await admin
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("conversation_id", conv.id)
      .eq("direction", "outbound")
      .in("sent_via", ["user", "external_device"])
      .gt("sent_at", conv.assigned_at);
    if ((falouAlgo ?? 0) > 0) continue;

    // Já cobramos por esta conversa há pouco?
    const desde = new Date(
      agora.getTime() - SILENCIO_ENTRE_COBRANCAS_H * 3_600_000,
    ).toISOString();
    const { count: cobrancaRecente } = await admin
      .from("event_log")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("event_type", "attendance.cobrado")
      .eq("payload->>conversation_id", conv.id)
      .gte("created_at", desde);
    if ((cobrancaRecente ?? 0) > 0) continue;

    const nomeDoLead =
      contato.name?.trim() || contato.display_name?.trim() || contato.phone_number || "Novo contato";
    const base = (env.NEXT_PUBLIC_APP_URL || "https://crm.zapinbox.com.br").replace(/\/$/, "");
    const fone = digitos(contato.phone_number);
    const texto = textoDaCobranca({
      nomeDoLead,
      quando: quandoEncaminhei(conv.assigned_at, agora),
      waLink: fone ? `https://wa.me/${fone}` : null,
      crmLink: `${base}/app/inbox/${conv.id}`,
    });

    const entregou = await enviarAoCorretor(admin, {
      organizationId,
      userId: conv.assigned_to_user_id,
      sessionName,
      texto,
    });
    if (!entregou) continue; // sem número ou WAHA fora: não marca, tenta depois

    try {
      await admin.rpc("emit_event" as never, {
        p_event_type: "attendance.cobrado",
        p_entity_kind: "conversation",
        p_entity_id: conv.id,
        p_payload: { conversation_id: conv.id, to_user_id: conv.assigned_to_user_id },
        p_metadata: { source: "attendance-cobranca" },
        p_organization_id: organizationId,
      } as never);
    } catch {
      // event_log best-effort: o aviso ja saiu, e sem o registro a proxima
      // passada pode cobrar de novo. Melhor cobrar duas vezes que nao cobrar.
    }
    resumo.cobrados += 1;
  }

  return resumo;
}

/** A sessão WAHA WORKING mais recente do tenant, ou null. */
async function sessaoWaha(
  admin: SupabaseClient,
  organizationId: string,
): Promise<string | null> {
  const { data } = await admin
    .from("channel_sessions")
    .select("waha_session_name")
    .eq("organization_id", organizationId)
    .eq("status", "WORKING")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { waha_session_name: string } | null)?.waha_session_name ?? null;
}

/**
 * Manda o texto pro WhatsApp pessoal do corretor. Mesmo cuidado do aviso de
 * lead novo: o chatId vem CONFERIDO no WhatsApp, porque conta brasileira antiga
 * tem JID sem o nono dígito e o envio "com sucesso" não chega em ninguém.
 */
async function enviarAoCorretor(
  admin: SupabaseClient,
  args: { organizationId: string; userId: string; sessionName: string | null; texto: string },
): Promise<boolean> {
  if (!args.sessionName) return false;
  try {
    const { data: membro } = await admin
      .from("user_organizations")
      .select("notify_whatsapp_e164")
      .eq("organization_id", args.organizationId)
      .eq("user_id", args.userId)
      .is("revoked_at", null)
      .maybeSingle();
    const phone = (membro as { notify_whatsapp_e164: string | null } | null)?.notify_whatsapp_e164;
    if (!phone) return false;
    const chatId = await resolveChatIdChecked({
      sessionName: args.sessionName,
      phoneNumber: phone,
    });
    if (!chatId) return false;
    const res = await sendWAHA({ sessionName: args.sessionName, chatId, text: args.texto });
    return res !== null;
  } catch (err) {
    logger.warn("[attendance.cobranca] falhou (ignorado)", {
      organization_id: args.organizationId,
      user_id: args.userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
