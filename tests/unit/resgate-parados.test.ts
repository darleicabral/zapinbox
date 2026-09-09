/**
 * @vitest-environment node
 *
 * A janela de resgate do lead parado. Cada resgate ACORDA UM CORRETOR no
 * WhatsApp dele, então errar pra mais é spam (o incidente de 01/09/2026: tempo
 * ligado sobre o acervo = 116 mensagens em 5 minutos) e errar pra menos é lead
 * esquecido (08/09: dois leads bloqueados por engano, um esperando desde 01/09).
 *
 * O critério é "de quem é a bola": a última mensagem da conversa é do LEAD.
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

import {
  casarNomeComMembro,
  estaNaJanelaDeResgate,
  idadeDaEsperaEstaNaJanela,
  leadEstaEsperando,
  minutosEsperando,
  nomeDoCorretorNaConversa,
} from "@/lib/attendance/parados";

const AGORA = new Date("2026-09-08T18:00:00.000Z");
const atras = (min: number) => new Date(AGORA.getTime() - min * 60_000).toISOString();

describe("de quem é a bola", () => {
  it("lead falou por último: é nossa", () => {
    expect(
      leadEstaEsperando({ last_inbound_at: atras(30), last_outbound_at: atras(45) }),
    ).toBe(true);
  });

  it("o caso pior: ele escreveu e NUNCA ouviu nada", () => {
    expect(leadEstaEsperando({ last_inbound_at: atras(30), last_outbound_at: null })).toBe(true);
  });

  it("nós falamos por último: a bola é dele, não se resgata", () => {
    // é o lead que sumiu depois da resposta do bot — isso é assunto do
    // follow-up, não de acordar corretor
    expect(
      leadEstaEsperando({ last_inbound_at: atras(45), last_outbound_at: atras(30) }),
    ).toBe(false);
  });

  it("conversa sem nenhuma entrada não é lead", () => {
    expect(leadEstaEsperando({ last_inbound_at: null, last_outbound_at: atras(5) })).toBe(false);
  });
});

describe("a janela", () => {
  it("o bot tem 15 minutos antes de alguém ser acordado", () => {
    expect(
      estaNaJanelaDeResgate({ last_inbound_at: atras(2), last_outbound_at: null }, AGORA),
    ).toBe(false);
    expect(
      estaNaJanelaDeResgate({ last_inbound_at: atras(14), last_outbound_at: null }, AGORA),
    ).toBe(false);
    expect(
      estaNaJanelaDeResgate({ last_inbound_at: atras(16), last_outbound_at: null }, AGORA),
    ).toBe(true);
  });

  it("pega os dois casos reais de 08/09", () => {
    // fernanda márcia, esperando 33 min depois de perguntar "Ele financia ???"
    expect(
      estaNaJanelaDeResgate({ last_inbound_at: atras(33), last_outbound_at: atras(34) }, AGORA),
    ).toBe(true);
    // Franciele, 6,9 dias esperando pra remarcar a visita
    expect(
      estaNaJanelaDeResgate({ last_inbound_at: atras(9969), last_outbound_at: atras(10016) }, AGORA),
    ).toBe(true);
  });

  it("acervo velho fica de fora — ressuscitar em massa é spam", () => {
    expect(
      estaNaJanelaDeResgate(
        { last_inbound_at: atras(8 * 24 * 60), last_outbound_at: null },
        AGORA,
      ),
    ).toBe(false);
    expect(
      estaNaJanelaDeResgate(
        { last_inbound_at: atras(60 * 24 * 60), last_outbound_at: null },
        AGORA,
      ),
    ).toBe(false);
  });

  it("exatamente 7 dias ainda entra, 7 dias e 1 minuto não", () => {
    expect(
      estaNaJanelaDeResgate({ last_inbound_at: atras(7 * 24 * 60), last_outbound_at: null }, AGORA),
    ).toBe(true);
    expect(
      estaNaJanelaDeResgate(
        { last_inbound_at: atras(7 * 24 * 60 + 1), last_outbound_at: null },
        AGORA,
      ),
    ).toBe(false);
  });
});

describe("minutosEsperando", () => {
  it("conta do último recado do lead", () => {
    expect(minutosEsperando({ last_inbound_at: atras(33) }, AGORA)).toBeCloseTo(33, 5);
  });

  it("sem entrada, não há espera", () => {
    expect(minutosEsperando({ last_inbound_at: null }, AGORA)).toBeNull();
  });
});

/**
 * Quem ja estava atendendo tem preferencia sobre o rodizio: "o lead nunca deve
 * passar adiante". O corretor escreve pelo aparelho dele prefixando o nome
 * ("*Robson:* oi Franciele"), que e a convencao que splitSenderPrefix entende.
 */
describe("devolver ao corretor que ja falou", () => {
  it("pega o nome do prefixo do caso Franciele", () => {
    expect(
      nomeDoCorretorNaConversa([
        "*Robson:* oi Franciele , boa tarde , vou te ligar as 17:30 para conversarmos",
      ]),
    ).toBe("Robson");
  });

  it("vale o mais recente, e a lista chega da mais nova pra mais velha", () => {
    expect(
      nomeDoCorretorNaConversa(["*Cleber:* seguimos amanha", "*Robson:* boa tarde"]),
    ).toBe("Cleber");
  });

  it("ignora saida sem prefixo e segue procurando", () => {
    expect(
      nomeDoCorretorNaConversa([null, "Boa tarde, tudo bem?", "*Gilvam:* ja te chamo"]),
    ).toBe("Gilvam");
  });

  it("mensagem do bot nao tem prefixo: ninguem atendia", () => {
    expect(
      nomeDoCorretorNaConversa(["Essa e a casa de 2 quartos com suite no Sao Paulo."]),
    ).toBeNull();
  });

  it("casa ignorando acento e caixa", () => {
    const membros = [
      { user_id: "u1", primeiro_nome: "Cléber" },
      { user_id: "u2", primeiro_nome: "Robson" },
    ];
    expect(casarNomeComMembro("cleber", membros)).toBe("u1");
    expect(casarNomeComMembro("ROBSON", membros)).toBe("u2");
  });

  it("nome ambiguo volta pro rodizio: chutar e pior que sortear", () => {
    const membros = [
      { user_id: "u1", primeiro_nome: "Marcos" },
      { user_id: "u2", primeiro_nome: "Marcos" },
    ];
    expect(casarNomeComMembro("Marcos", membros)).toBeNull();
  });

  it("nome que nao e da equipe volta pro rodizio", () => {
    expect(casarNomeComMembro("Fulano", [{ user_id: "u1", primeiro_nome: "Robson" }])).toBeNull();
    expect(casarNomeComMembro(null, [{ user_id: "u1", primeiro_nome: "Robson" }])).toBeNull();
  });
});

/**
 * 09/09/2026 — a coluna last_outbound_at e atualizada pela CADENCIA, entao lead
 * que so recebeu "Oi, ainda ta por ai?" parecia atendido e ficava invisivel pro
 * resgate. Era o pior caso possivel: lead que nunca ouviu uma palavra de
 * ninguem. A separacao entre idade e posse da bola e o que permite consultar as
 * mensagens so nesse caso ambiguo.
 */
describe("idade da espera, separada da posse da bola", () => {
  it("a Carmem PARECE atendida (o robo falou depois dela) mas a idade entra na janela", () => {
    const conv = { last_inbound_at: atras(9000), last_outbound_at: atras(60) };
    expect(estaNaJanelaDeResgate(conv, AGORA)).toBe(false); // bola parece nossa
    expect(idadeDaEsperaEstaNaJanela(conv, AGORA)).toBe(true); // mas espera ha 6 dias
  });

  it("acervo velho fica fora da janela mesmo pela idade", () => {
    expect(idadeDaEsperaEstaNaJanela({ last_inbound_at: atras(9 * 24 * 60) }, AGORA)).toBe(false);
  });

  it("lead de 2 minutos nao entra: o bot merece a chance", () => {
    expect(idadeDaEsperaEstaNaJanela({ last_inbound_at: atras(2) }, AGORA)).toBe(false);
  });
});
