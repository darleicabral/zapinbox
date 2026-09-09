/**
 * @vitest-environment node
 *
 * Duas travas da cadência de reengajamento, as duas nascidas de conversa real:
 *
 *  1. `ehMensagemDaCadencia` — a cadência não pode ser a ÚNICA coisa falando.
 *     A trava de 08/09 comparava com `last_outbound_at`, que a PRÓPRIA cadência
 *     atualiza: ela barrava o primeiro toque e liberava os outros quatro.
 *     Medido em 09/09 sobre as conversas de 03 a 09/09: 19 leads escreveram,
 *     nunca receberam resposta nenhuma, e levaram 141 toques.
 *
 *  2. `leadRecusou` — pedido do Darlei em 09/09, olhando o Ronaldo Costa: às
 *     09h07 ele respondeu "Bom dia, não obrigado" à oferta de simulação, o bot
 *     se despediu bem, e às 09h13 a cadência perguntou "Oi, ainda tá por aí?".
 *
 * Todas as frases de lead aqui saíram do banco da Avant nesta semana.
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

import { ehMensagemDaCadencia, leadRecusou } from "@/lib/followup/followup";
import type { FollowupStep } from "@/lib/followup/followup";

/** As 4 etapas configuradas na Avant em 09/09/2026. */
const STEPS: FollowupStep[] = [
  { after_minutes: 5, message: "Oi, ainda tá por aí?" },
  {
    after_minutes: 10,
    message:
      "Notei que você não pode responder no momento. Tem um horário melhor para falarmos sobre essa oportunidade?",
  },
  {
    after_minutes: 120,
    message: "Esse imóvel ainda tem ótimas condições de financiamento. Gostaria de realizar uma simulação?",
  },
  {
    after_minutes: 1440,
    message:
      "Oi, {nome}! Voltando aqui. A simulação continua de pé e leva menos de 2 minutos. Quer que eu faça?",
  },
];

describe("reconhecer a fala da própria cadência", () => {
  it("pela marca no metadata (mensagem nova)", () => {
    expect(ehMensagemDaCadencia("qualquer texto", { followup_step: 1 }, STEPS)).toBe(true);
    expect(ehMensagemDaCadencia("qualquer texto", { followup_step: 0 }, STEPS)).toBe(true);
  });

  it("pelo texto, pro acervo que não tem marca", () => {
    for (const s of STEPS) {
      expect(ehMensagemDaCadencia(s.message, null, STEPS), s.message).toBe(true);
    }
  });

  it("resolve o {nome} da última etapa com o nome real", () => {
    // é a frase que a Carmem e a Soraia receberam hoje às 9h
    expect(
      ehMensagemDaCadencia(
        "Oi, Carmem! Voltando aqui. A simulação continua de pé e leva menos de 2 minutos. Quer que eu faça?",
        null,
        STEPS,
      ),
    ).toBe(true);
    expect(
      ehMensagemDaCadencia(
        "Oi, Soraia! Voltando aqui. A simulação continua de pé e leva menos de 2 minutos. Quer que eu faça?",
        null,
        STEPS,
      ),
    ).toBe(true);
  });

  it("resposta de verdade do bot NÃO é cadência", () => {
    for (const frase of [
      "Essa é a casa de 2 quartos com suíte no São Paulo, R$ 290.000.",
      "O que mais chamou sua atenção nesse imóvel?",
      "Vou te encaminhar pro Gilvam, nosso corretor, ele já te chama aqui 👍",
      "Bom dia! 😊 Tranquilo, sem problema.",
      "Nesse tipo de imóvel o financiamento é direto com o proprietário.",
    ]) {
      expect(ehMensagemDaCadencia(frase, null, STEPS), frase).toBe(false);
    }
  });

  it("texto vazio não é cadência", () => {
    expect(ehMensagemDaCadencia("", null, STEPS)).toBe(false);
    expect(ehMensagemDaCadencia(null, null, STEPS)).toBe(false);
  });
});

describe("o caso que motivou a trava: Ronaldo Costa", () => {
  it("'Bom dia, não obrigado' é recusa, respondendo à oferta ou não", () => {
    expect(leadRecusou("Bom dia, não obrigado", { respondendoACadencia: true })).toBe(true);
    expect(leadRecusou("Bom dia, não obrigado", { respondendoACadencia: false })).toBe(true);
  });
});

describe("recusa que se explica sozinha", () => {
  it("vale em qualquer contexto", () => {
    for (const frase of [
      "Não obg",
      "não, obrigado",
      "Não tenho interesse",
      "sem interesse",
      "Não me interessa",
      "Não vou querer",
      "Desisti",
      "Já comprei outro",
      "já resolvi, obrigado",
      "Oi bom dia. Só tava olhando mesmo obrigado",
      "Nessas condições não me atende",
      "Conforme for o endereço, não me interessa",
    ]) {
      expect(leadRecusou(frase, { respondendoACadencia: false }), frase).toBe(true);
    }
  });
});

describe("encerramento que só conta como recusa em resposta a uma oferta", () => {
  it("toda etapa da cadência termina numa oferta, então aqui é recusa dela", () => {
    for (const frase of ["Não", "Ok obrigado", "Ok,obrigado.", "Obrigado", "valeu", "Tranquilo"]) {
      expect(leadRecusou(frase, { respondendoACadencia: true }), frase).toBe(true);
    }
  });

  it("no meio da conversa, um 'não' solto é resposta a uma pergunta, não recusa", () => {
    // o bot pergunta coisas de sim/não o tempo todo ("já tem financiamento?",
    // "conhece o bairro?"); encerrar a cadência aí seria chute
    for (const frase of ["Não", "Obrigado", "valeu", "beleza"]) {
      expect(leadRecusou(frase, { respondendoACadencia: false }), frase).toBe(false);
    }
  });
});

describe("o que NUNCA pode ser lido como recusa", () => {
  it("reclamação de abandono é o OPOSTO de recusa — o lead quer atenção", () => {
    for (const frase of [
      "Vcs não respondem",
      "Estou mas vc não fala nada",
      "Bom dia tenho interesse, só que não me responde as mensagens",
      "A gente fala sim, vocês respondem não. Pelo amor de Deus, gente.",
      "ninguém responde aqui",
      "cadê vocês?",
    ]) {
      expect(leadRecusou(frase, { respondendoACadencia: true }), frase).toBe(false);
      expect(leadRecusou(frase, { respondendoACadencia: false }), frase).toBe(false);
    }
  });

  it("confusão, pergunta e fala comum não são recusa", () => {
    for (const frase of [
      "Eu não entendi direito.",
      "Vc anuncia uma casa e não sabe o endereço?",
      "E não queria sair da régua",
      "Se não for no capela",
      "Porque trabalho dia. Sim outro não",
      "Não sei se consigo entrada",
      "Tenho interesse em adquirir",
      "Quero fazer um simulado",
      "Não, quero ver outras opções",
    ]) {
      expect(leadRecusou(frase, { respondendoACadencia: true }), frase).toBe(false);
    }
  });

  it("vazio não é recusa", () => {
    expect(leadRecusou("", { respondendoACadencia: true })).toBe(false);
    expect(leadRecusou(null, { respondendoACadencia: true })).toBe(false);
    expect(leadRecusou("   ", { respondendoACadencia: true })).toBe(false);
  });
});
