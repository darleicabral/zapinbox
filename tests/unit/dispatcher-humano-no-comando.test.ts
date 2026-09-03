/**
 * @vitest-environment node
 *
 * Regressão: o bot respondia por cima do corretor humano.
 *
 * `bot_silenced_until` só é preenchido pela tool de handoff, então corretor que
 * simplesmente começa a digitar (composer do CRM ou celular) não silenciava
 * nada. Medido em produção (03/09/2026, tenant avant): conversa 3456e9ba, o
 * Robson respondendo à mão 13:07:09 e 13:07:21, e o bot cortando 13:07:58 com
 * "Olá! Tudo bem? 😊 Aqui é o consultor da Avant". Mesma família do incidente do
 * follow-up de 01/09.
 *
 * A regra olha QUEM FALOU POR ÚLTIMO, não "humano falou depois do lead": o
 * despachante roda por causa de uma mensagem que acabou de chegar, então
 * comparar com last_inbound_at nunca pegaria nada.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: { INTERNAL_SECRET: "teste", NEXT_PUBLIC_APP_URL: "http://localhost:3000" },
}));
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { humanIsHandling } from "@/lib/ai/dispatcher";

const AGORA = new Date("2026-09-03T13:07:58Z").getTime();
const min = (n: number) => new Date(AGORA - n * 60_000).toISOString();

describe("humanIsHandling: bot não fala por cima do corretor", () => {
  it("corretor respondeu pelo CRM agora → bloqueia (o caso do Robson)", () => {
    expect(humanIsHandling({ sent_via: "user", sent_at: min(0.6) }, AGORA)).toEqual({
      via: "user",
      minutosAtras: 1,
    });
  });

  it("corretor respondeu pelo celular → bloqueia", () => {
    expect(humanIsHandling({ sent_via: "external_device", sent_at: min(5) }, AGORA)).toMatchObject({
      via: "external_device",
    });
  });

  it("o bot falou por último → segue (é ele que está atendendo)", () => {
    expect(humanIsHandling({ sent_via: "ai", sent_at: min(1) }, AGORA)).toBeNull();
  });

  it("humano respondeu e sumiu (fora da janela) → segue, a regra se cura", () => {
    expect(humanIsHandling({ sent_via: "user", sent_at: min(61) }, AGORA)).toBeNull();
  });

  it("conversa sem nenhuma saída → segue (primeiro contato)", () => {
    expect(humanIsHandling(null, AGORA)).toBeNull();
  });

  it("sent_via desconhecido não é tratado como humano", () => {
    expect(humanIsHandling({ sent_via: "system", sent_at: min(1) }, AGORA)).toBeNull();
    expect(humanIsHandling({ sent_via: null, sent_at: min(1) }, AGORA)).toBeNull();
  });

  it("saída humana sem data não bloqueia (dado incompleto não vira trava)", () => {
    expect(humanIsHandling({ sent_via: "user", sent_at: null }, AGORA)).toBeNull();
  });
});
