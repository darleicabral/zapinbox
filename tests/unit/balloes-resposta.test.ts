/**
 * @vitest-environment node
 *
 * Pedido do Darlei (03/09/2026): a IA pula uma linha pra trocar de assunto, e o
 * natural é que isso vire OUTRA mensagem no WhatsApp, como pessoa digitando, em
 * vez de um bloco só. O prompt já mandava "nunca envie um balão com mais de 2
 * linhas", mas o runtime enviava tudo junto e a regra não tinha efeito.
 *
 * O corte é só em LINHA EM BRANCO. Quebra de linha simples fica junto de
 * propósito, senão a listagem de opções ("Opção 1 📍 ... / 2 quartos · R$ ...")
 * chegaria picada.
 */
import { describe, expect, it, vi } from "vitest";

// finalize.ts puxa o handler de mensagens, que puxa lib/env e valida na
// IMPORTAÇÃO. A função sob teste é pura e não usa nada disso.
vi.mock("@/lib/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://exemplo.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "teste",
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    INTERNAL_SECRET: "teste",
  },
}));

import { MAX_BALOES, splitIntoBalloons } from "@/lib/ai/runtime/finalize";

describe("splitIntoBalloons", () => {
  it("a abertura do lead de campanha vira 3 balões", () => {
    const r = splitIntoBalloons(
      "Olá, tudo bem? 😊\n\nEssa é a casa geminada duplex de 3 quartos no Serra Dourada, R$ 415.000.\n\nO que mais chamou sua atenção nesse anúncio?",
    );
    expect(r).toEqual([
      "Olá, tudo bem? 😊",
      "Essa é a casa geminada duplex de 3 quartos no Serra Dourada, R$ 415.000.",
      "O que mais chamou sua atenção nesse anúncio?",
    ]);
  });

  it("quebra de linha SIMPLES não divide (listagem de opções fica inteira)", () => {
    const r = splitIntoBalloons("Opção 1 📍 Apartamento, Floramar\n2 quartos · 2 vagas · R$ 380.000");
    expect(r).toHaveLength(1);
    expect(r[0]).toContain("Opção 1");
    expect(r[0]).toContain("R$ 380.000");
  });

  it("texto sem linha em branco continua uma mensagem só", () => {
    expect(splitIntoBalloons("Qual dia fica melhor pra você?")).toEqual([
      "Qual dia fica melhor pra você?",
    ]);
  });

  it("linhas em branco repetidas e espaços não geram balão vazio", () => {
    expect(splitIntoBalloons("um\n\n\n   \n\ndois\n\n")).toEqual(["um", "dois"]);
  });

  it("passando do teto, o excedente vai junto no último balão", () => {
    const texto = ["a", "b", "c", "d", "e", "f", "g"].join("\n\n");
    const r = splitIntoBalloons(texto);
    expect(r).toHaveLength(MAX_BALOES);
    expect(r[MAX_BALOES - 1]).toBe("e\n\nf\n\ng");
  });

  it("a mensagem-gatilho fica sozinha no seu balão", () => {
    const r = splitIntoBalloons(
      "Só confirmando aqui a disponibilidade da agenda pra amanhã às 15h.\n\nSó um momento",
    );
    expect(r[r.length - 1]).toBe("Só um momento");
  });

  it("texto vazio não gera balão", () => {
    expect(splitIntoBalloons("   \n\n  ")).toEqual([]);
  });
});
