/**
 * @vitest-environment node
 *
 * O alarme de bot quebrado. Existe porque em 06–08/09/2026 o bot da Avant ficou
 * DOIS DIAS sem responder — 156 execuções com HTTP 400 do provider — e ninguém
 * foi avisado. O sintoma chegou ao Darlei de forma enganosa, como "a IA está
 * deixando de mandar leads pro corretor".
 *
 * As duas formas de morrer não se parecem, e é por isso que há dois critérios:
 * na falha as execuções acontecem e quebram; no silêncio elas não nascem, e aí
 * a taxa de falha é 0% — um alarme que só olhasse falha veria tudo verde.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://exemplo.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "teste",
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    INTERNAL_SECRET: "teste",
  },
}));

import { diagnosticar } from "@/lib/ops/alarme-runs";

describe("o apagão de 07-08/09, que deveria ter alarmado", () => {
  it("80 execuções, 80 falhas: alarma por falha", () => {
    const d = diagnosticar({ runs: 80, falhas: 80, entradas: 40 });
    expect(d.alarmar).toBe(true);
    expect(d.motivo).toBe("falha");
    expect(d.pctFalha).toBe(100);
    expect(d.texto).toContain("80 de 80");
  });

  it("o dia anterior, com 76 de 80: também alarma", () => {
    const d = diagnosticar({ runs: 80, falhas: 76, entradas: 40 });
    expect(d.alarmar).toBe(true);
    expect(d.motivo).toBe("falha");
    expect(d.pctFalha).toBe(95);
  });
});

describe("dispatcher parado: execução nenhuma nasce", () => {
  it("mensagens de lead entrando e zero execução alarma por silêncio", () => {
    const d = diagnosticar({ runs: 0, falhas: 0, entradas: 12 });
    expect(d.alarmar).toBe(true);
    expect(d.motivo).toBe("silencio");
    expect(d.texto).toContain("12 mensagens");
  });

  it("a taxa de falha aqui é 0% e enganaria um alarme que só olhasse falha", () => {
    const d = diagnosticar({ runs: 0, falhas: 0, entradas: 12 });
    expect(d.pctFalha).toBe(0);
    expect(d.alarmar).toBe(true);
  });

  it("madrugada de sábado: sem execução E sem mensagem é sossego, não defeito", () => {
    expect(diagnosticar({ runs: 0, falhas: 0, entradas: 0 }).alarmar).toBe(false);
    expect(diagnosticar({ runs: 0, falhas: 0, entradas: 2 }).alarmar).toBe(false);
  });
});

describe("o que NÃO pode alarmar", () => {
  it("o dia de hoje, 18 execuções sem falha nenhuma", () => {
    expect(diagnosticar({ runs: 18, falhas: 0, entradas: 20 }).alarmar).toBe(false);
  });

  it("uma falha isolada no meio de muitas execuções", () => {
    expect(diagnosticar({ runs: 30, falhas: 2, entradas: 30 }).alarmar).toBe(false);
  });

  it("amostra pequena não alarma, mesmo com tudo falhando", () => {
    // 1 de 1 é 100%, mas uma execução não é evidência de nada
    expect(diagnosticar({ runs: 1, falhas: 1, entradas: 1 }).alarmar).toBe(false);
    expect(diagnosticar({ runs: 3, falhas: 3, entradas: 3 }).alarmar).toBe(false);
  });

  it("na borda: 4 execuções com 30% já alarma", () => {
    // 4 execuções é o mínimo da amostra; 2 de 4 são 50%
    expect(diagnosticar({ runs: 4, falhas: 2, entradas: 4 }).alarmar).toBe(true);
    // 1 de 4 são 25%, abaixo do limite
    expect(diagnosticar({ runs: 4, falhas: 1, entradas: 4 }).alarmar).toBe(false);
  });
});

describe("o texto tem de dizer o que fazer, não só que quebrou", () => {
  it("na falha, aponta pro erro das execuções", () => {
    const d = diagnosticar({ runs: 20, falhas: 20, entradas: 20 });
    expect(d.texto).toContain("erro das execuções");
  });

  it("no silêncio, diz que não é falta de movimento", () => {
    const d = diagnosticar({ runs: 0, falhas: 0, entradas: 9 });
    expect(d.texto).toContain("não é falta de movimento");
  });
});

/**
 * 🐛 10/09/2026 — duas execucoes morreram com `token_budget_exceeded` e o
 * alarme nao viu nada, porque so olhava `failed`. Do ponto de vista do lead nao
 * ha diferenca: ninguem respondeu.
 *
 * `skipped` continua fora de proposito -- e a decisao deliberada de nao
 * responder (conversa ocupada, bot silenciado, contato interno), que e o sistema
 * funcionando.
 */
describe("execucao abortada tambem e nao-resposta", () => {
  it("aborto conta como falha na conta do alarme", () => {
    // 5 de 10 abortadas = 50%, acima do limite
    const d = diagnosticar({ runs: 10, falhas: 5, entradas: 10 });
    expect(d.alarmar).toBe(true);
    expect(d.motivo).toBe("falha");
  });

  it("o caso real de hoje NAO alarmaria sozinho, e esta certo", () => {
    // 2 abortos em 51 execucoes = 4%: e ruido, nao apagao
    const d = diagnosticar({ runs: 51, falhas: 2, entradas: 40 });
    expect(d.alarmar).toBe(false);
    expect(d.pctFalha).toBe(4);
  });
});
