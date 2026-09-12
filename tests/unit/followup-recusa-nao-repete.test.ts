/**
 * @vitest-environment node
 *
 * 🐛 12/09/2026 — REGRESSÃO MINHA, DE ONTEM.
 *
 * O conserto de 11/09 (falaQueDecide, a recusa escondida atrás das gentilezas
 * da Raphaela) funcionou: a cadência parou. Mas o ramo que registra a recusa
 * ficou rodando A CADA TIQUE do cron.
 *
 * Medido em 36h de event_log: **453 eventos `followup.recusado` para DUAS
 * conversas**, sendo **448 numa só** — a Raphaela, de 11/09 12:19 até 12/09
 * 11:59, aproximadamente um a cada 4 minutos.
 *
 * Nenhum lead foi incomodado (este ramo não envia mensagem nenhuma), mas era
 * escrita e evento infinitos, crescendo com cada lead que recusa.
 *
 * A regra que faltava é a mais velha do mundo: **só registrar quando o estado
 * MUDA**. Quem já está no fim da fila já saiu da cadência, e sair de novo não
 * é notícia.
 */
import { describe, expect, it } from "vitest";

/**
 * Espelha a decisão do varredor: dado o estado atual da conversa e o veredito
 * da recusa, isto GRAVA alguma coisa?
 */
function vaiRegistrarARecusa(args: {
  followupStep: number;
  totalDeEtapas: number;
  recusou: boolean;
}): boolean {
  if (!args.recusou) return false;
  const jaEstavaForaDaCadencia = args.followupStep >= args.totalDeEtapas;
  return !jaEstavaForaDaCadencia;
}

describe("recusa registra uma vez, não a cada tique", () => {
  const ETAPAS = 4;

  it("a primeira passada registra", () => {
    expect(vaiRegistrarARecusa({ followupStep: 2, totalDeEtapas: ETAPAS, recusou: true })).toBe(true);
  });

  it("a Raphaela, que já estava no fim da fila, nunca deveria ter registrado", () => {
    // era exatamente o estado dela: followup_step 4 de 4 etapas
    expect(vaiRegistrarARecusa({ followupStep: 4, totalDeEtapas: ETAPAS, recusou: true })).toBe(false);
  });

  it("os 448 tiques seguintes ficam todos em silêncio", () => {
    // depois de registrar uma vez, o estado vira ETAPAS e não registra mais
    let gravacoes = 0;
    let step = 2;
    for (let tique = 0; tique < 450; tique++) {
      if (vaiRegistrarARecusa({ followupStep: step, totalDeEtapas: ETAPAS, recusou: true })) {
        gravacoes++;
        step = ETAPAS;
      }
    }
    expect(gravacoes).toBe(1);
  });

  it("conversa que não recusou nunca entra no ramo", () => {
    expect(vaiRegistrarARecusa({ followupStep: 0, totalDeEtapas: ETAPAS, recusou: false })).toBe(false);
  });

  /**
   * O limite honesto: se o lead VOLTAR e a cadência reiniciar (followup_step
   * volta a zero), uma recusa nova volta a ser registrada. É o comportamento
   * certo — aí o estado mudou de verdade.
   */
  it("lead que reengajou e recusou de novo registra outra vez", () => {
    expect(vaiRegistrarARecusa({ followupStep: 0, totalDeEtapas: ETAPAS, recusou: true })).toBe(true);
  });
});
