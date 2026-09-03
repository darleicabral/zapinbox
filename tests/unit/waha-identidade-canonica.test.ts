/**
 * @vitest-environment node
 *
 * Regressão: o mesmo remetente do WhatsApp virava DOIS contatos.
 *
 * Medido em produção (03/09/2026, tenant avant): o mesmo remetente
 * `260094914756808@lid` gerou os contatos `ae0a1186` (wa_identity
 * `phone:+553196829676`) e `646d5444` (`lid:260094914756808`), criados 41
 * segundos um do outro. Como a conversa é keyada por contato+sessão, a thread do
 * WhatsApp partiu em duas conversas no CRM (654023d4 e 137904e5) e a segunda
 * nasceu sem histórico: o bot cumprimentou e se apresentou DE NOVO no meio do
 * atendimento, logo depois de já ter dado a abertura correta.
 *
 * A causa era o upsert keyar pela forma de chegada (`phone:` ou `lid:`) em vez
 * de pelo telefone, que é a identidade estável. O phoneHint (key.senderPn) era
 * extraído e usado só pra preencher phone_number depois, no duplicado.
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

import { canonicalContactIdentity } from "@/lib/waha/ingest";

describe("canonicalContactIdentity: telefone é a identidade estável", () => {
  it("chat @c.us: keya pelo telefone do próprio chat", () => {
    expect(canonicalContactIdentity({ kind: "phone", phone: "+553196829676", lid: null }, null)).toEqual({
      kind: "phone",
      phone: "+553196829676",
      lid: null,
    });
  });

  it("chat @lid COM senderPn: keya pelo telefone, não pelo lid (o bug)", () => {
    expect(
      canonicalContactIdentity({ kind: "lid", phone: null, lid: "260094914756808" }, "+553196829676"),
    ).toEqual({ kind: "phone", phone: "+553196829676", lid: null });
  });

  it("as duas formas de chegada do MESMO remetente caem na mesma identidade", () => {
    const porTelefone = canonicalContactIdentity({ kind: "phone", phone: "+553196829676", lid: null }, null);
    const porLid = canonicalContactIdentity(
      { kind: "lid", phone: null, lid: "260094914756808" },
      "+553196829676",
    );
    expect(porLid).toEqual(porTelefone);
  });

  it("chat @lid SEM senderPn: segue como lid (número realmente protegido)", () => {
    expect(canonicalContactIdentity({ kind: "lid", phone: null, lid: "260094914756808" }, null)).toEqual({
      kind: "lid",
      phone: null,
      lid: "260094914756808",
    });
  });

  it("telefone do chat vence, mesmo com hint diferente", () => {
    // O chat @c.us já É o número do remetente; hint divergente não sobrepõe.
    expect(
      canonicalContactIdentity({ kind: "phone", phone: "+553196829676", lid: null }, "+5531999999999"),
    ).toEqual({ kind: "phone", phone: "+553196829676", lid: null });
  });
});
