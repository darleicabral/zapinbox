/**
 * @vitest-environment node
 *
 * O bot ENCERRA o turno sem resolver e ninguém assume. Três formas do mesmo
 * problema, todas tiradas de conversa real:
 *
 *  1. 04/09 — promete humano e não chama (lead Ronaldo): "Boa pergunta, deixa
 *     eu confirmar isso certinho com a equipe", sem tool, sem corretor. O lead
 *     esperou 33 minutos; o follow-up o trouxe de volta e o bot enrolou de novo
 *     ("Já te retorno, tô finalizando uma coisa aqui").
 *
 *  2. 05/09 — não soube responder: "Você tem terrenos menor?" / "Boa pergunta!
 *     Deixa eu ver o que temos em terrenos menores por aqui pra te passar
 *     certinho." E não voltou.
 *
 *  3. 05/09 — visita que não fechou (lead João): ele disse "vou me organizar e
 *     te retorno", o bot respondeu "me chama que eu já confirmo a agenda", e a
 *     cadência foi cobrar ele 6 minutos depois.
 *
 * Regra do Darlei nos prints de 05/09: "a IA não deveria insistir assim, poderia
 * passar para o corretor... ele disse que quer visitar, mas o agente não
 * conseguiu agendar" e "nesse aqui a IA não soube responder a pergunta, passe ao
 * corretor também".
 *
 * O RECORTE é o que evita estrago: só o ÚLTIMO parágrafo conta. Das 27 execuções
 * medidas em 04/09 com frase de espera, 24 não tinham handoff — mas a maioria
 * era MULETA, com o bot respondendo logo em seguida. Acionar todas silenciaria o
 * bot à toa.
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

import { botParouSemResolver } from "@/lib/ai/runtime/handoff";

describe("1. promete humano e não chama ninguém", () => {
  it("pega o abandono seco", () => {
    expect(botParouSemResolver("Só um momento.")).toContain("esperar");
    expect(botParouSemResolver("Já te retorno, tô finalizando uma coisa aqui.")).toContain(
      "esperar",
    );
  });

  it("pega a promessa de falar com a equipe", () => {
    expect(
      botParouSemResolver("Boa pergunta, deixa eu confirmar isso certinho com a equipe. 😊"),
    ).toContain("equipe");
  });

  it("pega o encaminhamento anunciado sem tool", () => {
    expect(
      botParouSemResolver("Vou te encaminhar pro Gilvam, nosso corretor, ele já te chama aqui 👍"),
    ).toContain("equipe");
  });

  it("pega a simulação prometida", () => {
    expect(botParouSemResolver("Sua simulação ficará pronta em instantes.")).toContain("esperar");
  });
});

describe("2. não soube responder e ficou de voltar (print de 05/09)", () => {
  it("pega o caso dos terrenos menores, palavra por palavra", () => {
    expect(
      botParouSemResolver(
        "Boa pergunta! Deixa eu ver o que temos em terrenos menores por aqui pra te passar certinho.",
      ),
    ).toContain("não soube responder");
  });

  it("pega as variações de verificar", () => {
    expect(botParouSemResolver("Vou verificar isso pra você.")).toContain("não soube responder");
    expect(botParouSemResolver("Deixa eu dar uma olhada aqui.")).toContain("não soube responder");
  });
});

describe("3. visita que não fechou (print de 05/09)", () => {
  it("pega o 'me chama que eu confirmo' do caso João", () => {
    const texto =
      "Fechado! Vou deixar anotado aqui pra te encaixar. 😊\n\nAssim que você tiver certeza do dia e horário, me chama que eu já confirmo a agenda pra você.";
    expect(botParouSemResolver(texto)).toContain("não fechou dia e horário");
  });

  it("pega o 'tô por aqui pra encaixar'", () => {
    expect(
      botParouSemResolver("Valeu, João! Quando confirmar, tô por aqui pra encaixar sua visita. 🙌"),
    ).toContain("não fechou dia e horário");
  });
});

describe("o que NÃO pode acionar", () => {
  it("muleta seguida de resposta não é parada", () => {
    // o caso mais comum nos dados: ele avisa que vai conferir e confere
    expect(
      botParouSemResolver(
        "Entendi! Deixa eu confirmar certinho essa casa no catálogo.\n\nConfirmei aqui: é a casa de 2 quartos com suíte no São Paulo, R$ 290.000.",
      ),
    ).toBeNull();
    expect(
      botParouSemResolver(
        "Deixa eu ver os detalhes pra você!\n\nO bairro São Paulo fica na Região Nordeste de Belo Horizonte.",
      ),
    ).toBeNull();
  });

  it("terminar PERGUNTANDO não é parar", () => {
    // regra rural: dá os dois números e OFERECE o corretor. Acionar aqui
    // silenciaria o bot antes de o lead dizer se quer.
    expect(
      botParouSemResolver(
        "Nesse tipo de imóvel o financiamento é direto com o proprietário, com entrada de 10% e em até 150 vezes.\n\nA correção e o resto dos detalhes quem te passa certinho é o corretor. Quer que eu chame ele agora?",
      ),
    ).toBeNull();
    expect(botParouSemResolver("Quer que eu chame o corretor pra você agora? 😊")).toBeNull();
    expect(botParouSemResolver("Me chama quando decidir, pode ser? 😊")).toBeNull();
  });

  it("resposta normal não aciona", () => {
    for (const frase of [
      "Olá, tudo bem? 😊",
      "Essa é a casa de 2 quartos com suíte no São Paulo, R$ 290.000.",
      "O que mais chamou sua atenção nela?",
      "Ela fica no bairro São Paulo, em Belo Horizonte, na região Nordeste da cidade.",
      "Condições de entrada, parcela e financiamento dependem do perfil de cada cliente.",
      "Confirmado! Sua visita é sábado à tarde.",
    ]) {
      expect(botParouSemResolver(frase), frase).toBeNull();
    }
  });

  it("texto vazio não aciona", () => {
    expect(botParouSemResolver("")).toBeNull();
    expect(botParouSemResolver("   \n\n  ")).toBeNull();
  });
});
