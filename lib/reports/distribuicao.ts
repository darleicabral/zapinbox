/**
 * Distribuição de leads por corretor — quantos cada um recebeu por notificação,
 * e o que fez com eles.
 *
 * Pedido do Darlei (04/09/2026): "preciso de um relatório que apareça quantos
 * leads foram enviados (via notificação) para cada um dos corretores", em tempo
 * real.
 *
 * POR QUE `conversations.assigned_to_user_id` É A FONTE. A notificação em si não
 * é persistida (notify.ts manda direto pelo WAHA, de propósito, pra não virar
 * conversa no inbox). Mas desde 04/09 o lead NUNCA passa adiante: quem foi
 * atribuído é quem foi avisado, e continua sendo. Então `assigned_at` +
 * `assigned_to_user_id` é o registro de quem recebeu o quê — sem tabela nova.
 *
 * Limite honesto disso: se o envio do WhatsApp falhar (corretor sem telefone
 * cadastrado, WAHA fora), o lead conta como "recebido" aqui mesmo sem o aviso
 * ter chegado. `semTelefone` na linha do corretor existe pra deixar isso à
 * vista, em vez de mentir por omissão.
 *
 * Função PURA: a rota busca as linhas escopadas por org e chama aqui.
 */

export interface ConversaAtribuida {
  id: string;
  assigned_to_user_id: string | null;
  assigned_at: string | null;
}

/** Saída HUMANA (celular do corretor ou composer do CRM), não do bot. */
export interface RespostaHumana {
  conversation_id: string;
  created_at: string;
}

export interface Corretor {
  userId: string;
  nome: string;
  /** Sem telefone de aviso: recebe o lead no CRM, mas não recebe o WhatsApp. */
  semTelefone: boolean;
}

export interface LinhaCorretor {
  userId: string;
  nome: string;
  semTelefone: boolean;
  recebidos: number;
  respondidos: number;
  semResposta: number;
  /** Mediana, não média: um lead esquecido por 6h não distorce o número todo. */
  medianaRespostaMin: number | null;
}

export interface DistribuicaoReport {
  desde: string;
  total: number;
  /** Atribuídos a quem não é (mais) da equipe — some quando alguém sai. */
  foraDaEquipe: number;
  corretores: LinhaCorretor[];
}

function mediana(valores: number[]): number | null {
  if (valores.length === 0) return null;
  const v = [...valores].sort((a, b) => a - b);
  const meio = Math.floor(v.length / 2);
  return v.length % 2 === 1 ? v[meio]! : Math.round((v[meio - 1]! + v[meio]!) / 2);
}

export function computeDistribuicao(
  conversas: ConversaAtribuida[],
  respostas: RespostaHumana[],
  corretores: Corretor[],
  desde: string,
): DistribuicaoReport {
  // Primeira resposta humana de cada conversa.
  const primeiraResposta = new Map<string, number>();
  for (const r of respostas) {
    const t = Date.parse(r.created_at);
    if (Number.isNaN(t)) continue;
    const atual = primeiraResposta.get(r.conversation_id);
    if (atual == null || t < atual) primeiraResposta.set(r.conversation_id, t);
  }

  const porCorretor = new Map<string, { recebidos: number; esperas: number[]; respondidos: number }>();
  let foraDaEquipe = 0;
  let total = 0;

  for (const c of conversas) {
    if (!c.assigned_to_user_id || !c.assigned_at) continue;
    total += 1;
    if (!corretores.some((x) => x.userId === c.assigned_to_user_id)) {
      foraDaEquipe += 1;
      continue;
    }
    const acc =
      porCorretor.get(c.assigned_to_user_id) ??
      { recebidos: 0, esperas: [], respondidos: 0 };
    acc.recebidos += 1;
    const resp = primeiraResposta.get(c.id);
    const atribuido = Date.parse(c.assigned_at);
    // Só conta como resposta a que veio DEPOIS da atribuição: mensagem anterior
    // é de outro momento do atendimento e inflaria o número.
    if (resp != null && !Number.isNaN(atribuido) && resp >= atribuido) {
      acc.respondidos += 1;
      acc.esperas.push(Math.round((resp - atribuido) / 60_000));
    }
    porCorretor.set(c.assigned_to_user_id, acc);
  }

  const linhas: LinhaCorretor[] = corretores.map((c) => {
    const acc = porCorretor.get(c.userId);
    return {
      userId: c.userId,
      nome: c.nome,
      semTelefone: c.semTelefone,
      recebidos: acc?.recebidos ?? 0,
      respondidos: acc?.respondidos ?? 0,
      semResposta: (acc?.recebidos ?? 0) - (acc?.respondidos ?? 0),
      medianaRespostaMin: mediana(acc?.esperas ?? []),
    };
  });
  // Mais leads primeiro; empate resolve por nome, pra a ordem não dançar entre
  // recargas (é painel em tempo real).
  linhas.sort((a, b) => b.recebidos - a.recebidos || a.nome.localeCompare(b.nome));

  return { desde, total, foraDaEquipe, corretores: linhas };
}
