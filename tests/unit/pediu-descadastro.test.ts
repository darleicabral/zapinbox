/**
 * @vitest-environment node
 *
 * Bloquear contato por palavra-chave de descadastro. É a decisão mais cara do
 * ingest: o contato fica `is_blocked`, o bot emudece, o follow-up para e NINGUÉM
 * é avisado — o lead simplesmente deixa de ser atendido, em silêncio.
 *
 * A regra antiga era `\b(STOP|PARAR|SAIR|UNSUBSCRIBE)\b`. Medida em 08/09/2026
 * sobre as 1000 mensagens recebidas mais recentes: **zero acertos e dois erros**,
 * os dois com lead querendo comprar. Os dois estão travados aqui embaixo.
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

import { pediuDescadastro } from "@/lib/waha/ingest";

describe("os dois leads que a regra antiga bloqueou por engano", () => {
  it("01/09 — o lead estava MARCANDO VISITA", () => {
    expect(
      pediuDescadastro(
        "Aqui tive que sair e só vou chegar depois de 19:00 tem como ser amanhã na parte da manhã?",
      ),
    ).toBe(false);
  });

  it("08/09 — fernanda márcia, que mora ao lado do imóvel", () => {
    expect(pediuDescadastro("E não queria sair da régua")).toBe(false);
  });
});

describe("a palavra no meio da frase nunca basta", () => {
  it("não bloqueia fala comum de lead", () => {
    for (const frase of [
      "Vou sair do aluguel esse ano",
      "Preciso sair do centro, tá muito barulho",
      "Quero parar de pagar aluguel",
      "Tenho que sair agora, te chamo mais tarde",
      "Dá pra parar na frente da portaria?",
      "Como faço pra sair da BR e chegar no condomínio?",
      "Já pensei em remover a parede da sala",
      "Vou cancelar meu contrato atual e comprar",
    ]) {
      expect(pediuDescadastro(frase), frase).toBe(false);
    }
  });
});

describe("o pedido inequívoco continua bloqueando", () => {
  it("palavra-comando sozinha, com ou sem pontuação e caixa", () => {
    for (const frase of ["PARAR", "parar", "Sair", "sair.", "STOP", "stop!", "  Cancelar  ", "descadastrar", "UNSUBSCRIBE"]) {
      expect(pediuDescadastro(frase), frase).toBe(true);
    }
  });

  it("frase que só existe pra descadastrar", () => {
    for (const frase of [
      "me tira da lista",
      "Me remove da lista por favor",
      "não quero mais receber mensagens",
      "Não quero receber nada de vocês",
      "pare de me mandar mensagem",
      "quero me descadastrar",
      "quero sair da lista",
    ]) {
      expect(pediuDescadastro(frase), frase).toBe(true);
    }
  });
});

describe("vazio", () => {
  it("não bloqueia", () => {
    expect(pediuDescadastro(null)).toBe(false);
    expect(pediuDescadastro(undefined)).toBe(false);
    expect(pediuDescadastro("")).toBe(false);
    expect(pediuDescadastro("   ")).toBe(false);
  });
});
