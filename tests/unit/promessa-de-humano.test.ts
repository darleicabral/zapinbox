/**
 * @vitest-environment node
 *
 * 🐛 04/09/2026 — o bot PROMETIA humano e não chamava ninguém.
 *
 * Caso que motivou (conversa 1757a01f, lead Ronaldo): às 08h28 ele perguntou
 * sobre permuta e o bot respondeu "Boa pergunta, deixa eu confirmar isso
 * certinho com a equipe. 😊" — sem chamar `crm_request_human_handoff`.
 * `last_handoff_at` nulo, nenhum corretor atribuído, zero ferramenta no run. O
 * lead esperou 33 minutos. O follow-up o trouxe de volta às 09h01, ele
 * respondeu "Sim", e o bot enrolou de novo: "Só um momento, que já confirmo
 * isso pra você" e depois "Já te retorno, tô finalizando uma coisa aqui".
 *
 * É sintoma da aderência a ferramenta medida em 03/09 (~25% de uso de tool no
 * DeepSeek contra ~75% no Sonnet). Outra regra no prompt não resolveria.
 *
 * O RECORTE É O QUE IMPORTA. Medindo as 27 execuções que continham frase de
 * espera, 24 não tinham handoff — mas a maioria era MULETA: o bot dizia "deixa
 * eu confirmar" e respondia em seguida. Acionar todas silenciaria o bot à toa.
 * Só o ÚLTIMO parágrafo conta, e pergunta no fim não é promessa.
 */
import { describe, expect, it, vi } from "vitest";

// handoff.ts puxa lib/supabase/admin -> lib/env, que valida env na IMPORTAÇÃO e
// derruba a suíte. A função sob teste é pura e não usa nada disso.
vi.mock("@/lib/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://exemplo.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "teste",
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    INTERNAL_SECRET: "teste",
  },
}));

import { prometeuHumano } from "@/lib/ai/runtime/handoff";

describe("prometeuHumano: promessa de verdade", () => {
  // frases reais, tiradas das conversas
  it("pega o abandono seco", () => {
    expect(prometeuHumano("Só um momento.")).toBe(true);
    expect(prometeuHumano("Já te retorno, tô finalizando uma coisa aqui.")).toBe(true);
  });

  it("pega a promessa de falar com a equipe", () => {
    expect(prometeuHumano("Boa pergunta, deixa eu confirmar isso certinho com a equipe. 😊")).toBe(
      true,
    );
    expect(prometeuHumano("Só um momento, que já confirmo isso pra você. 👍")).toBe(true);
  });

  it("pega a simulação prometida", () => {
    expect(prometeuHumano("Sua simulação ficará pronta em instantes.")).toBe(true);
  });

  it("pega o encaminhamento anunciado sem tool", () => {
    expect(
      prometeuHumano("Vou te encaminhar pro Gilvam, nosso corretor, ele já te chama aqui 👍"),
    ).toBe(true);
  });

  it("olha o ÚLTIMO parágrafo, não o primeiro", () => {
    const texto =
      "Essa parte da correção eu prefiro que o corretor te explique certinho.\n\nSó um momento que ele já te chama aqui.";
    expect(prometeuHumano(texto)).toBe(true);
  });
});

describe("prometeuHumano: o que NÃO pode acionar", () => {
  it("muleta seguida de resposta não é promessa", () => {
    // o caso mais comum nos dados: ele avisa que vai conferir e confere
    expect(
      prometeuHumano(
        "Entendi! Deixa eu confirmar certinho essa casa no catálogo.\n\nConfirmei aqui: é a casa de 2 quartos com suíte no São Paulo, R$ 290.000.",
      ),
    ).toBe(false);
    expect(
      prometeuHumano(
        "Deixa eu confirmar os detalhes certinho pra você!\n\nO bairro São Paulo fica na Região Nordeste de Belo Horizonte.",
      ),
    ).toBe(false);
  });

  it("terminar PERGUNTANDO não é prometer", () => {
    // regra rural: dá os dois números e OFERECE o corretor. Acionar aqui
    // silenciaria o bot antes de o lead dizer se quer.
    expect(
      prometeuHumano(
        "Nesse tipo de imóvel o financiamento é direto com o proprietário, com entrada de 10% e em até 150 vezes.\n\nA correção e o resto dos detalhes quem te passa certinho é o corretor. Quer que eu chame ele agora?",
      ),
    ).toBe(false);
  });

  it("pergunta com emoji no fim também não aciona", () => {
    expect(prometeuHumano("Quer que eu chame o corretor pra você agora? 😊")).toBe(false);
  });

  it("resposta normal não aciona", () => {
    for (const frase of [
      "Olá, tudo bem? 😊",
      "Essa é a casa de 2 quartos com suíte no São Paulo, R$ 290.000.",
      "O que mais chamou sua atenção nela?",
      "Ela fica no bairro São Paulo, em Belo Horizonte, na região Nordeste da cidade.",
      "Condições de entrada, parcela e financiamento dependem do perfil de cada cliente.",
    ]) {
      expect(prometeuHumano(frase), frase).toBe(false);
    }
  });

  it("texto vazio não aciona", () => {
    expect(prometeuHumano("")).toBe(false);
    expect(prometeuHumano("   \n\n  ")).toBe(false);
  });
});
