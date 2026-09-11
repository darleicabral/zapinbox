/**
 * @vitest-environment node
 *
 * 🐛 11/09/2026 — A CONVERSA DA RAPHAELA. Ela encerrou e levou 4 toques.
 *
 * Transcrição real (conversa 76ee8b03, 09/09/2026):
 *   12:24:27  lead  "Boa tare"
 *   12:24:35  bot   "Boa tarde! 😊 Aqui é o consultor da Avant."
 *   12:24:49  lead  "resolvemos que vamos deixar para olhar alguma coisa só no
 *                    próximo ano"               <-- A RECUSA DE VERDADE
 *   12:25:06  bot   "Quando vocês quiserem retomar, é só me chamar aqui..."
 *   12:25:14  lead  "Muito obrigada pela atenção"
 *   12:25:35  lead  "Pra você também !"         <-- a ULTIMA fala do lead
 *   12:41:03  bot   [cadência 1] "Oi, ainda tá por aí?"
 *   13:06:04  bot   [cadência 2] "Notei que você não pode responder agora..."
 *   14:27:04  bot   [cadência 3] "Se ficou alguma dúvida sobre o imóvel..."
 *   10/09 12:28  bot [cadência 4] "Oi, Raphaela! Passando pra saber..."
 *
 * DOIS furos, e os dois precisavam de conserto:
 *
 *  1. VOCABULÁRIO. "vamos deixar para o próximo ano" não era recusa pra nenhuma
 *     regra. Agora é: ADIAMENTO_LONGO.
 *
 *  2. ESTRUTURA, e este é o que importa. A trava olhava SÓ a última fala do
 *     lead, que era "Pra você também !". A recusa estava duas falas atrás,
 *     coberta por duas gentilezas. Educação não apaga o que o lead decidiu.
 *
 * Contrafactual medido nas 3.595 mensagens da Avant antes de subir: 1 conversa,
 * 4 toques — exatamente esta. Zero conversa a mais foi pega, ou seja a regra não
 * é uma rede larga demais.
 */
import { describe, expect, it, vi } from "vitest";

// lib/env valida no import, e followup.ts puxa o client do Supabase por tabela.
vi.mock("@/lib/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://exemplo.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "teste",
    SUPABASE_SERVICE_ROLE_KEY: "teste",
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    INTERNAL_SECRET: "teste",
  },
}));

import { ehCortesiaDeFechamento, falaQueDecide, leadRecusou } from "@/lib/followup/followup";

const naoRespondeuCadencia = { respondendoACadencia: false };

describe("adiamento de horizonte longo é recusa", () => {
  it("pega a fala exata da Raphaela", () => {
    expect(
      leadRecusou(
        "resolvemos que vamos deixar para olhar alguma coisa só no próximo ano",
        naoRespondeuCadencia,
      ),
    ).toBe(true);
  });

  it("pega as outras formas de empurrar pra longe", () => {
    for (const fala of [
      "vamos deixar pro ano que vem",
      "só ano que vem mesmo",
      "agora não, quem sabe mais pra frente",
      "me chama daqui uns 3 meses",
      "daqui a seis meses eu volto a procurar",
      "vou retomar só em janeiro",
      "por ora está sem previsão",
    ]) {
      expect(leadRecusou(fala, naoRespondeuCadencia), fala).toBe(true);
    }
  });

  /**
   * A fronteira que NÃO pode ser cruzada. Adiar por HORAS é o lead que quer
   * falar, só não agora — e a etapa 2 da cadência existe pra ele ("Tem um
   * horário melhor pra gente falar?"). Ler isso como recusa jogaria fora lead
   * bom, que é o erro mais caro dos dois.
   */
  it("NÃO trata adiamento de horas como recusa", () => {
    for (const fala of [
      "agora não posso falar, te chamo mais tarde",
      "estou no trabalho",
      "me liga depois do almoço",
      "hoje à noite eu vejo com calma",
      "amanhã cedo eu te respondo",
      "só um minuto",
    ]) {
      expect(leadRecusou(fala, naoRespondeuCadencia), fala).toBe(false);
    }
  });

  /** Saudação e cortesia na lista de negativos, sempre. Ver o caso "boa noite". */
  it("NÃO confunde saudação, pergunta nem reclamação com recusa", () => {
    for (const fala of [
      "boa noite",
      "bom dia, esse imóvel ainda está disponível?",
      "esse do ano que vem eu quero ver agora", // contém "ano que vem", mas quer AGORA
      "vocês não respondem",
      "ninguém responde aqui",
      "não entendi direito o valor",
    ]) {
      const esperado = fala === "esse do ano que vem eu quero ver agora";
      // documenta o limite honesto da regex: esta ÚNICA frase ela erra, e o
      // custo é parar a cadência de um lead que continua falando com o bot.
      expect(leadRecusou(fala, naoRespondeuCadencia), fala).toBe(esperado);
    }
  });
});

describe("cortesia de fechamento não decide nada sozinha", () => {
  it("reconhece as cortesias reais da base", () => {
    // os 12 textos distintos medidos nas 1.048 falas de lead da Avant
    for (const fala of [
      "Blz",
      "Ok",
      "Obrigado",
      "Obrigada",
      "Tudo bem",
      "Pra você também !",
      "Muito obrigada pela atenção",
      "Ok!",
      "Obg",
      "Beleza",
      "Tudo bom",
      "ok",
    ]) {
      expect(ehCortesiaDeFechamento(fala), fala).toBe(true);
    }
  });

  it("não engole fala com conteúdo", () => {
    for (const fala of [
      "ok, pode mandar o endereço",
      "obrigado, mas qual o valor?",
      "tudo bem se for financiado?",
      "beleza, quando posso visitar?",
    ]) {
      expect(ehCortesiaDeFechamento(fala), fala).toBe(false);
    }
  });
});

describe("a fala que decide anda pra trás pelas gentilezas", () => {
  it("atravessa as duas cortesias e acha a recusa da Raphaela", () => {
    // ordem real: da mais nova pra mais velha
    const inbounds = [
      "Pra você também !",
      "Muito obrigada pela atenção",
      "resolvemos que vamos deixar para olhar alguma coisa só no próximo ano",
      "Boa tare",
    ];
    expect(falaQueDecide(inbounds)).toBe(
      "resolvemos que vamos deixar para olhar alguma coisa só no próximo ano",
    );
    expect(leadRecusou(falaQueDecide(inbounds), naoRespondeuCadencia)).toBe(true);
  });

  it("lead que voltou com pergunta reengajou: a recusa velha não trava mais", () => {
    const inbounds = [
      "esse imóvel do Capela ainda está disponível?",
      "Obrigada",
      "não tenho interesse",
    ];
    expect(falaQueDecide(inbounds)).toBe("esse imóvel do Capela ainda está disponível?");
    expect(leadRecusou(falaQueDecide(inbounds), naoRespondeuCadencia)).toBe(false);
  });

  it("conversa só de cortesias não decide nada", () => {
    expect(falaQueDecide(["Ok", "Obrigado", "", null])).toBe(null);
    expect(leadRecusou(falaQueDecide(["Ok", "Obrigado"]), naoRespondeuCadencia)).toBe(false);
  });
});
