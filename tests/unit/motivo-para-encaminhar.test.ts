/**
 * @vitest-environment node
 *
 * Regra do Darlei (04/09/2026): "quando ele usar esses termos mais tarde,
 * depois, à noite, ocupado, no trabalho, a gente tem que passar pro corretor e
 * deixar isso avisado no resumo de IA".
 *
 * Nasceu do print do Marcos: ele respondeu "Eu estou no trabalho" e o bot
 * seguiu qualificando ("sábado de qual horário?") enquanto a cadência o cobrava
 * a cada 6 minutos. Quem avisa a hora está dando um dado de AGENDA, e agenda é
 * assunto de corretor.
 *
 * O recado devolvido vai no aviso do WhatsApp do corretor, antes do resumo,
 * porque é o que muda a ação dele agora: ligar às 10h ou às 19h.
 */
import { describe, expect, it, vi } from "vitest";

// handoff.ts puxa lib/supabase/admin -> lib/env, que valida na IMPORTAÇÃO.
vi.mock("@/lib/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://exemplo.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "teste",
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    INTERNAL_SECRET: "teste",
  },
}));

import { motivoDoLeadParaEncaminhar } from "@/lib/ai/runtime/handoff";

describe("aviso de agenda: o lead disse quando pode falar", () => {
  it("pega o caso do Marcos", () => {
    const r = motivoDoLeadParaEncaminhar("Eu estou no trabalho");
    expect(r).toContain("está no trabalho agora");
    // o recado carrega a frase dele, pro corretor ler o original
    expect(r).toContain("Eu estou no trabalho");
  });

  it("pega as variações de estar no trabalho", () => {
    expect(motivoDoLeadParaEncaminhar("tô no trabalho agora")).toContain("trabalho");
    expect(motivoDoLeadParaEncaminhar("estou no trampo")).toContain("trabalho");
  });

  it("pega ocupado", () => {
    expect(motivoDoLeadParaEncaminhar("estou ocupado agora")).toContain("ocupado");
    expect(motivoDoLeadParaEncaminhar("tô meio ocupado")).toContain("ocupado");
    expect(motivoDoLeadParaEncaminhar("sem tempo agora")).toContain("ocupado");
  });

  it("pega o pedido de falar mais tarde", () => {
    expect(motivoDoLeadParaEncaminhar("me chama mais tarde")).toContain("mais tarde");
    expect(motivoDoLeadParaEncaminhar("depois eu te falo")).toContain("mais tarde");
    expect(motivoDoLeadParaEncaminhar("depois a gente conversa")).toContain("mais tarde");
  });

  it("pega o fim do dia", () => {
    expect(motivoDoLeadParaEncaminhar("à noite eu vejo isso")).toContain("fim do dia");
    expect(motivoDoLeadParaEncaminhar("me liga depois do trabalho")).toContain("fim do dia");
    expect(motivoDoLeadParaEncaminhar("quando eu sair do trabalho eu respondo")).toContain("fim do dia");
  });

  it("pega outro dia", () => {
    expect(motivoDoLeadParaEncaminhar("amanhã a gente fala")).toContain("outro dia");
  });
});

describe("o que NÃO é motivo pra encaminhar", () => {
  it("resposta comum não aciona", () => {
    for (const frase of [
      "Sim",
      "Ok",
      "Quanto custa?",
      "qual a Localização ?",
      "Gostei da casa",
      "Pode mandar mais fotos",
      "trabalho em BH, perto do centro",
      "meu trabalho é aqui do lado",
    ]) {
      expect(motivoDoLeadParaEncaminhar(frase), frase).toBeNull();
    }
  });

  it("vazio devolve null", () => {
    expect(motivoDoLeadParaEncaminhar("")).toBeNull();
    expect(motivoDoLeadParaEncaminhar("   ")).toBeNull();
  });

  /**
   * Bordas que ACIONAM de propósito: o lead está propondo horário de visita.
   * Encaminhar é o certo — agendar visita é trabalho do corretor, não do bot.
   */
  it("proposta de horário também vai pro corretor, e isso é desejado", () => {
    expect(motivoDoLeadParaEncaminhar("pode ser hoje mais tarde?")).toContain("mais tarde");
    expect(motivoDoLeadParaEncaminhar("prefiro visitar à noite")).toContain("fim do dia");
  });
});

/**
 * 05/09/2026 — regra do Darlei, depois de um print em que o lead insistiu no
 * endereço e a IA ficou perguntando se podia chamar alguém: "se pedirem o
 * endereço completo, já pode passar direto para o corretor sem ficar pedindo
 * autorização do lead".
 */
describe("pedido de endereço vai direto pro corretor", () => {
  it("pega o pedido de endereço em várias formas", () => {
    for (const frase of [
      "Manda o endereço do imóvel por favor",
      "qual o endereço?",
      "Me passa o endereco completo",
      "Qual é a rua?",
      "qual o nome da rua",
      "me manda a localização",
      "queria a localização exata",
    ]) {
      expect(motivoDoLeadParaEncaminhar(frase), frase).toContain("ENDEREÇO");
    }
  });

  it("'qual a localização?' sozinho NÃO encaminha", () => {
    // a essa o bot responde com o bairro, que é informação boa e não precisa de
    // humano. Encaminhar aqui gastaria corretor com pergunta que a IA resolve.
    expect(motivoDoLeadParaEncaminhar("qual a Localização ?")).toBeNull();
    expect(motivoDoLeadParaEncaminhar("Em que bairro fica?")).toBeNull();
  });
});
