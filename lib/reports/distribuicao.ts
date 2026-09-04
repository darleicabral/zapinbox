/**
 * Distribuição de leads por corretor — quantos cada um recebeu por notificação.
 *
 * Pedido do Darlei (04/09/2026): "preciso de um relatório que apareça quantos
 * leads foram enviados (via notificação) para cada um dos corretores", em tempo
 * real.
 *
 * ⚠️ POR QUE NÃO TEM "RESPONDEU". A primeira versão media resposta do corretor
 * e o Darlei cortou: "todos eles irão continuar sem resposta no sistema, pois
 * cada corretor atende do seu próprio WhatsApp. Não temos como registrar isso.
 * Então entenda, a partir do momento que enviamos a notificação para o corretor,
 * não é mais problema nosso."
 *
 * O CRM só enxerga o que passa pelo número da imobiliária. Corretor falando com
 * o lead do celular PESSOAL é invisível aqui — então "sem resposta" media
 * ausência de dado, não abandono, e mostraria "Robson respondeu 0 de 5" para
 * quem talvez tenha atendido os 5. Métrica que engana é pior que métrica
 * nenhuma. A régua é a ENTREGA do lead, e ela para aí de propósito.
 *
 * POR QUE `conversations.assigned_to_user_id` É A FONTE. A notificação em si não
 * é persistida (notify.ts manda direto pelo WAHA, pra não virar conversa no
 * inbox). Mas desde 04/09 o lead NUNCA passa adiante: quem foi atribuído é quem
 * foi avisado, e continua sendo. Então `assigned_at` + `assigned_to_user_id` é o
 * registro de quem recebeu o quê, sem tabela nova.
 *
 * Função PURA: a rota busca as linhas escopadas por org e chama aqui.
 */

export interface ConversaAtribuida {
  id: string;
  assigned_to_user_id: string | null;
  assigned_at: string | null;
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
  /** Fatia do total, em pontos percentuais inteiros. */
  fatiaPct: number;
}

export interface DistribuicaoReport {
  desde: string;
  total: number;
  /** Atribuídos a quem não é (mais) da equipe — some quando alguém sai. */
  foraDaEquipe: number;
  corretores: LinhaCorretor[];
}

export function computeDistribuicao(
  conversas: ConversaAtribuida[],
  corretores: Corretor[],
  desde: string,
): DistribuicaoReport {
  const porCorretor = new Map<string, number>();
  let foraDaEquipe = 0;
  let total = 0;

  for (const c of conversas) {
    if (!c.assigned_to_user_id || !c.assigned_at) continue;
    total += 1;
    if (!corretores.some((x) => x.userId === c.assigned_to_user_id)) {
      foraDaEquipe += 1;
      continue;
    }
    porCorretor.set(c.assigned_to_user_id, (porCorretor.get(c.assigned_to_user_id) ?? 0) + 1);
  }

  const linhas: LinhaCorretor[] = corretores.map((c) => {
    const recebidos = porCorretor.get(c.userId) ?? 0;
    return {
      userId: c.userId,
      nome: c.nome,
      semTelefone: c.semTelefone,
      recebidos,
      fatiaPct: total > 0 ? Math.round((recebidos / total) * 100) : 0,
    };
  });
  // Mais leads primeiro; empate resolve por nome, pra a ordem não dançar entre
  // recargas (é painel em tempo real).
  linhas.sort((a, b) => b.recebidos - a.recebidos || a.nome.localeCompare(b.nome));

  return { desde, total, foraDaEquipe, corretores: linhas };
}
