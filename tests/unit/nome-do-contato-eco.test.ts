/**
 * @vitest-environment node
 *
 * 🐛 03/09/2026 — 50 contatos da Avant estavam com o nome da PRÓPRIA
 * imobiliária, e a notificação chegava pro corretor dizendo
 * "👤 *Avant Negócios Imobiliários*" em vez de quem procurou.
 *
 * Causa: em mensagem `fromMe` (o corretor respondendo do celular dele, ou o eco
 * do que o CRM enviou) o `notifyName` do payload é O NOSSO push name, não o do
 * cliente. O ingest gravava isso como nome do lead.
 *
 * Provado em 12 de 12: todo contato com o nome errado tinha como primeira
 * mensagem um outbound `external_device` ("*Robson:* Bom dia Eliane"). Contato
 * com nome de pessoa (Clayton, panificadoraclaranunes83) começou com entrada.
 */
import { describe, expect, it, vi } from "vitest";

// ingest.ts puxa lib/supabase/server -> lib/env, que valida env na IMPORTAÇÃO e
// derruba a suíte. A função sob teste é pura e não usa nada disso.
vi.mock("@/lib/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://exemplo.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "teste",
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  },
}));

import { nomeParaContato } from "@/lib/waha/ingest";

/** Payload mínimo; só o que a função lê. */
function payload(notifyName?: string, pushName?: string) {
  return { _data: { notifyName, pushName } } as never;
}

describe("nomeParaContato", () => {
  it("mensagem do cliente: usa o push name dele", () => {
    expect(nomeParaContato(payload("Clayton"), false)).toBe("Clayton");
  });

  it("ECO de saída: NÃO usa o nome, porque ali o nome é o nosso", () => {
    expect(nomeParaContato(payload("Avant Negócios Imobiliários"), true)).toBeNull();
  });

  it("eco continua null mesmo com pushName no lugar de notifyName", () => {
    expect(nomeParaContato(payload(undefined, "Avant Negócios Imobiliários"), true)).toBeNull();
  });

  it("entrada cai no pushName quando não vem notifyName", () => {
    expect(nomeParaContato(payload(undefined, "drika"), false)).toBe("drika");
  });

  it("entrada sem nome nenhum devolve null (a UI cai no telefone)", () => {
    expect(nomeParaContato(payload(), false)).toBeNull();
  });
});
