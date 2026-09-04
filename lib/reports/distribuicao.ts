/**
 * Funil de distribuição: quantos leads chegaram, quantos a IA conseguiu
 * encaminhar, e quanto cada corretor recebeu.
 *
 * Pedido do Darlei (04/09/2026): "quantos leads foram enviados (via
 * notificação) para cada um dos corretores", em tempo real, e depois "podemos
 * incluir quantos leads chegaram também... pra gente ter uma noção de quantos
 * chegaram e quantos a IA conseguiu mandar para o corretor".
 *
 * UM CONJUNTO SÓ, de propósito: a janela filtra pela CHEGADA da conversa, e
 * "encaminhados" é o pedaço dela que ganhou dono. Se um número saísse da data de
 * chegada e o outro da data de atribuição, dava pra ter mais encaminhado do que
 * chegou, e a taxa viraria ficção. O custo é que lead que chegou ontem e foi
 * encaminhado hoje conta no dia de ONTEM.
 *
 * ⚠️ POR QUE NÃO TEM "RESPONDEU". A primeira versão media resposta do corretor e
 * o Darlei cortou: "cada corretor atende do seu próprio WhatsApp. Não temos como
 * registrar isso. Então entenda, a partir do momento que enviamos a notificação
 * para o corretor, não é mais problema nosso". O CRM só enxerga o que passa pelo
 * número da imobiliária, então "sem resposta" media ausência de dado, não
 * abandono. A régua para na ENTREGA.
 *
 * POR QUE `assigned_to_user_id` VALE COMO "avisado": a notificação não é
 * persistida (notify.ts manda direto pelo WAHA, pra não virar conversa no
 * inbox), mas desde 04/09 o lead NUNCA passa adiante — quem foi atribuído é quem
 * foi avisado, e continua sendo.
 *
 * Função PURA: a rota busca as linhas escopadas por org e chama aqui.
 */

export interface ConversaChegada {
  id: string;
  assigned_to_user_id: string | null;
  /** Conversa do próprio corretor (eco do aviso) não é lead. */
  interno: boolean;
  /** Sem mensagem do cliente não é lead: é eco, teste ou conversa vazia. */
  temEntrada: boolean;
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
  /** Fatia do que foi ENCAMINHADO (não do que chegou), em % inteiro. */
  fatiaPct: number;
}

export interface DistribuicaoReport {
  desde: string;
  /** Leads de verdade que entraram na janela. */
  chegaram: number;
  /** Quantos desses ganharam corretor. */
  encaminhados: number;
  /** Chegaram e continuam sem ninguém. */
  semCorretor: number;
  /** Encaminhados a quem não é (mais) da equipe. */
  foraDaEquipe: number;
  corretores: LinhaCorretor[];
}

export function computeDistribuicao(
  conversas: ConversaChegada[],
  corretores: Corretor[],
  desde: string,
): DistribuicaoReport {
  const porCorretor = new Map<string, number>();
  let chegaram = 0;
  let encaminhados = 0;
  let foraDaEquipe = 0;

  for (const c of conversas) {
    if (c.interno || !c.temEntrada) continue; // não é lead
    chegaram += 1;
    if (!c.assigned_to_user_id) continue;
    encaminhados += 1;
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
      fatiaPct: encaminhados > 0 ? Math.round((recebidos / encaminhados) * 100) : 0,
    };
  });
  // Mais leads primeiro; empate resolve por nome, pra a ordem não dançar entre
  // recargas (é painel em tempo real).
  linhas.sort((a, b) => b.recebidos - a.recebidos || a.nome.localeCompare(b.nome));

  return {
    desde,
    chegaram,
    encaminhados,
    semCorretor: chegaram - encaminhados,
    foraDaEquipe,
    corretores: linhas,
  };
}
