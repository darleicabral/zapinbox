/**
 * @vitest-environment node
 *
 * 🚨 12/09/2026 — O ALARME GRITOU "NÃO RODOU NENHUMA VEZ" COM 7 RUNS RODANDO.
 *
 * Às 11h30 chegou ao Darlei:
 *   "🚨 O bot não está atendendo. Chegaram 8 mensagens de lead na última hora
 *    e o agente não rodou NENHUMA vez."
 *
 * Reproduzindo a MESMA janela (10:30:27 → 11:30:27 BRT):
 *   runs     = 7  (5 completed, 2 handoff, zero falha)
 *   entradas = 8  — e as OITO em conversa já entregue a corretor
 *
 * Dois defeitos somados, e os dois viram teste aqui:
 *
 *  1. LEITURA QUE FALHA VIRAVA ZERO. `const { data: runs } = await ...`
 *     descartava o `error`; data = null virava `[]` pelo `?? []`, e lista vazia
 *     é indistinguível de "o bot não rodou". O alarme afirmava como FATO o que
 *     era uma consulta que não voltou. Mesma família do pipeline que declarava
 *     sucesso sobre arquivo velho.
 *
 *  2. A CONTA DE ENTRADAS INCLUÍA QUEM O BOT NÃO DEVE ATENDER. Depois do
 *     handoff a conversa fica silenciada e o lead segue falando com o CORRETOR
 *     pelo mesmo número. Cada fala dessas entrava como "lead abandonado".
 *
 * Custo do alarme falso: ele diz "os leads estão escrevendo e ninguém está
 * respondendo". Alarme que mente é pior que alarme nenhum, porque o próximo
 * de verdade é ignorado.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://exemplo.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "teste",
    SUPABASE_SERVICE_ROLE_KEY: "teste",
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    INTERNAL_SECRET: "teste",
  },
}));

import { diagnosticar, MINIMO_DE_ENTRADAS_SEM_RUN } from "@/lib/ops/alarme-runs";

describe("a manhã real de 12/09, que não era problema nenhum", () => {
  it("com 7 runs saudáveis e 0 entradas órfãs, não alarma", () => {
    // depois do conserto: as 8 entradas eram de conversa entregue a corretor,
    // então a conta que chega no diagnóstico é ZERO.
    const d = diagnosticar({ runs: 7, falhas: 0, entradas: 0 });
    expect(d.alarmar).toBe(false);
    expect(d.motivo).toBe(null);
  });

  /**
   * A trava que realmente importa: mesmo que a conta de entradas estivesse
   * inflada, 7 runs já provam que o bot está vivo. Silêncio exige runs = 0.
   */
  it("com runs acontecendo, silêncio nunca alarma, por mais entradas que haja", () => {
    for (const entradas of [3, 8, 40]) {
      expect(diagnosticar({ runs: 7, falhas: 0, entradas }).motivo, `entradas=${entradas}`).not.toBe(
        "silencio",
      );
    }
  });
});

describe("silêncio de verdade continua alarmando", () => {
  it("zero run com lead órfão escrevendo é o apagão de 06-08/09", () => {
    const d = diagnosticar({ runs: 0, falhas: 0, entradas: MINIMO_DE_ENTRADAS_SEM_RUN });
    expect(d.alarmar).toBe(true);
    expect(d.motivo).toBe("silencio");
    expect(d.texto).toMatch(/não está atendendo/i);
  });

  it("madrugada parada não vira alarme: pouca entrada, sem amostra", () => {
    const d = diagnosticar({ runs: 0, falhas: 0, entradas: MINIMO_DE_ENTRADAS_SEM_RUN - 1 });
    expect(d.alarmar).toBe(false);
  });
});

describe("falha continua sendo pega", () => {
  it("execuções quebrando acima do limite alarmam", () => {
    const d = diagnosticar({ runs: 10, falhas: 5, entradas: 10 });
    expect(d.alarmar).toBe(true);
    expect(d.motivo).toBe("falha");
    expect(d.pctFalha).toBe(50);
  });

  it("uma falha isolada em amostra pequena não alarma", () => {
    expect(diagnosticar({ runs: 3, falhas: 1, entradas: 3 }).alarmar).toBe(false);
  });
});
