/**
 * @vitest-environment node
 *
 * 🐛 25/09/2026 (Tete) — a cliente disse "Pod ser segunda feira", o run começou
 * e leu "segunda"; ~1 min DEPOIS, durante o run, ela corrigiu pra "Domingo". O
 * run terminou gravando "segunda" e o handoff silenciou a conversa, jogando a
 * correção fora. A guarda: se a última fala do lead é mais nova que o INÍCIO do
 * run, o run não a viu → não encaminha (nem silencia).
 */
import { describe, expect, it, vi } from "vitest";

// handoff.ts puxa o orquestrador → lib/env, que valida env e explode no teste.
vi.mock("@/lib/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://exemplo.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "teste",
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    INTERNAL_SECRET: "teste",
  },
}));

import { handoffDeveEsperar } from "@/lib/mcp/tools/handoff";

describe("handoffDeveEsperar", () => {
  it("Tete — correção 'Domingo' chegou depois do início do run → espera", () => {
    const runComecou = "2026-09-25T14:59:17Z";
    const ultimaFalaDoLead = "2026-09-25T15:00:23Z"; // "Da?", depois do "Domingo agr"
    expect(handoffDeveEsperar(runComecou, ultimaFalaDoLead)).toBe(true);
  });

  it("fala do lead que o run JÁ leu (anterior ao início) → encaminha normal", () => {
    const runComecou = "2026-09-25T14:59:17Z";
    const ultimaFalaDoLead = "2026-09-25T14:59:14Z"; // "Pod ser segunda feira"
    expect(handoffDeveEsperar(runComecou, ultimaFalaDoLead)).toBe(false);
  });

  it("mesmo instante não conta como mais nova", () => {
    expect(handoffDeveEsperar("2026-09-25T14:59:17Z", "2026-09-25T14:59:17Z")).toBe(false);
  });

  it("sem dado (run ou última fala) não segura o handoff", () => {
    expect(handoffDeveEsperar(null, "2026-09-25T15:00:00Z")).toBe(false);
    expect(handoffDeveEsperar("2026-09-25T14:59:17Z", null)).toBe(false);
    expect(handoffDeveEsperar(null, null)).toBe(false);
  });
});
