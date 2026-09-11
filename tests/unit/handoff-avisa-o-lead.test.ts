/**
 * @vitest-environment node
 *
 * 🐛 11/09/2026 — A JUNIA MARIA FICOU FALANDO SOZINHA.
 *
 * Transcrição real (conversa d8f6ec8e, 11/09/2026):
 *   13:56:50  lead  "Qual a sua disponibilidade? Pq eu tenho saio do serviço às 17h"
 *   13:57:05  bot   "Consigo te encaixar depois das 17h, sem problema. 😊"
 *   13:57:08  bot   "Qual dia fica melhor pra você?"
 *   13:57:10  ►     handoff pro Gilvam, bot_silenced_until = infinity
 *   13:57:43  lead  "Posso te mandar da segunda,? Pq tenho que ver no trabalho"
 *   13:57:57  lead  "VC teria outras unidades TMB na região?"
 *
 * O corretor FOI avisado às 13:57:17, e com o texto certo ("O lead deu um
 * horário — ele está marcando a visita"). Quem não foi avisada foi ELA: o bot
 * fez uma pergunta e emudeceu pra sempre, e ela respondeu duas vezes no vazio.
 *
 * Por que só acontece fora da ferramenta: quando o MODELO chama a tool de
 * handoff, ele sabe que está encaminhando e escreve a despedida certa. Nos
 * gatilhos de SISTEMA (sentinela, promessa, adiamento) quem decide é o código,
 * DEPOIS que o modelo já falou — e o texto dele foi escrito supondo que a
 * conversa continuava.
 *
 * Medido em todos os 168 handoffs da Avant: 16 leads encaminhados sem nunca
 * ouvir quem vai atender, e 13 deles seguiram falando sozinhos.
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

import { avisoDeQuemVaiAtender, precisaAvisarQuemAtende } from "@/lib/ai/runtime/handoff";

describe("o aviso de quem vai atender", () => {
  it("cita o nome do corretor quando o rodízio atribuiu alguém", () => {
    const texto = avisoDeQuemVaiAtender("Gilvam");
    expect(texto).toContain("Gilvam");
    expect(texto).toMatch(/encaminhar/i);
  });

  /**
   * Regra do Darlei, que vale desde sempre: NUNCA inventar nome de corretor.
   * Sem atribuição, o texto fala de "equipe" e não chuta ninguém.
   */
  it("sem corretor atribuído, fala em equipe e não inventa nome", () => {
    const texto = avisoDeQuemVaiAtender(null);
    expect(texto).toMatch(/equipe/i);
    expect(texto).not.toMatch(/\bpro [A-Z]/);
  });
});

describe("quando o sistema precisa completar a despedida do modelo", () => {
  it("a fala real da Junia exigia o aviso: era uma pergunta em aberto", () => {
    expect(precisaAvisarQuemAtende("Qual dia fica melhor pra você?")).toBe(true);
  });

  it("modelo mudo também exige o aviso", () => {
    expect(precisaAvisarQuemAtende("")).toBe(true);
    expect(precisaAvisarQuemAtende(null)).toBe(true);
    expect(precisaAvisarQuemAtende(undefined)).toBe(true);
  });

  /**
   * O outro lado: se o modelo JÁ avisou, repetir soa como robô travado. Estes
   * textos saíram das despedidas reais dos handoffs desta semana.
   */
  it("não repete quando o modelo já disse quem vai atender", () => {
    for (const fala of [
      "Vou te encaminhar pro Robson, nosso corretor, ele já te chama aqui pra agendar 👍",
      "Vou te passar pro nosso corretor agora.",
      "Só um momento",
      "Sem problema! Nossa equipe já te chama aqui.",
      "O corretor te chama ainda hoje.",
    ]) {
      expect(precisaAvisarQuemAtende(fala), fala).toBe(false);
    }
  });

  /**
   * As outras despedidas de sistema medidas na base, todas em aberto. Sem o
   * aviso, cada uma destas deixou um lead conversando com um bot silenciado.
   */
  it("exige o aviso nas despedidas reais que ficaram em aberto", () => {
    for (const fala of [
      "Quer conhecer de perto? Qual dia fica melhor pra você?",
      "Quarta, perfeito! E prefere manhã ou tarde?",
      "Boa pergunta, deixa eu confirmar isso certinho com a equipe.",
      "Sua simulação ficará pronta em instantes",
      "O que mais chamou sua atenção nesse imóvel?",
    ]) {
      expect(precisaAvisarQuemAtende(fala), fala).toBe(true);
    }
  });
});
