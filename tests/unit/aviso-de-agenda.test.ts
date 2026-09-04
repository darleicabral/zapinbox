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

import { avisoDeAgenda } from "@/lib/ai/runtime/handoff";

describe("avisoDeAgenda: o lead disse quando pode falar", () => {
  it("pega o caso do Marcos", () => {
    const r = avisoDeAgenda("Eu estou no trabalho");
    expect(r).toContain("está no trabalho agora");
    // o recado carrega a frase dele, pro corretor ler o original
    expect(r).toContain("Eu estou no trabalho");
  });

  it("pega as variações de estar no trabalho", () => {
    expect(avisoDeAgenda("tô no trabalho agora")).toContain("trabalho");
    expect(avisoDeAgenda("estou no trampo")).toContain("trabalho");
  });

  it("pega ocupado", () => {
    expect(avisoDeAgenda("estou ocupado agora")).toContain("ocupado");
    expect(avisoDeAgenda("tô meio ocupado")).toContain("ocupado");
    expect(avisoDeAgenda("sem tempo agora")).toContain("ocupado");
  });

  it("pega o pedido de falar mais tarde", () => {
    expect(avisoDeAgenda("me chama mais tarde")).toContain("mais tarde");
    expect(avisoDeAgenda("depois eu te falo")).toContain("mais tarde");
    expect(avisoDeAgenda("depois a gente conversa")).toContain("mais tarde");
  });

  it("pega o fim do dia", () => {
    expect(avisoDeAgenda("à noite eu vejo isso")).toContain("fim do dia");
    expect(avisoDeAgenda("me liga depois do trabalho")).toContain("fim do dia");
    expect(avisoDeAgenda("quando eu sair do trabalho eu respondo")).toContain("fim do dia");
  });

  it("pega outro dia", () => {
    expect(avisoDeAgenda("amanhã a gente fala")).toContain("outro dia");
  });
});

describe("avisoDeAgenda: o que NÃO é aviso de agenda", () => {
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
      expect(avisoDeAgenda(frase), frase).toBeNull();
    }
  });

  it("vazio devolve null", () => {
    expect(avisoDeAgenda("")).toBeNull();
    expect(avisoDeAgenda("   ")).toBeNull();
  });

  /**
   * Bordas que ACIONAM de propósito: o lead está propondo horário de visita.
   * Encaminhar é o certo — agendar visita é trabalho do corretor, não do bot.
   */
  it("proposta de horário também vai pro corretor, e isso é desejado", () => {
    expect(avisoDeAgenda("pode ser hoje mais tarde?")).toContain("mais tarde");
    expect(avisoDeAgenda("prefiro visitar à noite")).toContain("fim do dia");
  });
});
