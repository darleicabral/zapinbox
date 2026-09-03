/**
 * @vitest-environment node
 *
 * O WAHA reporta a mídia recebida no localhost DELE
 * (`http://localhost:3000/api/files/...`). Guardar essa URL crua causava dois
 * estragos, descobertos em 03/09/2026:
 *
 *  1. a rota /api/v1/messages/[id]/media valida `startsWith(waha.origin)` e
 *     devolvia 422 — foto e áudio de cliente ficavam invisíveis pro corretor;
 *  2. a transcrição de áudio não tinha como baixar o arquivo (ECONNREFUSED).
 */
import { describe, expect, it } from "vitest";

import { publicWahaMediaUrl } from "@/lib/waha/client";

const BASE = "https://waha.zapinbox.com.br";

describe("publicWahaMediaUrl", () => {
  it("troca o localhost interno pela base pública, preservando o caminho", () => {
    expect(
      publicWahaMediaUrl(
        "http://localhost:3000/api/files/org_4b5162b2_1feedd/ACB0C479.oga",
        BASE,
      ),
    ).toBe(`${BASE}/api/files/org_4b5162b2_1feedd/ACB0C479.oga`);
  });

  it("preserva query string (token de arquivo em versões novas do WAHA)", () => {
    expect(publicWahaMediaUrl("http://localhost:3000/api/files/a/b.oga?t=9", BASE)).toBe(
      `${BASE}/api/files/a/b.oga?t=9`,
    );
  });

  it("não duplica barra quando a base termina com /", () => {
    expect(publicWahaMediaUrl("http://localhost:3000/api/files/x.oga", `${BASE}/`)).toBe(
      `${BASE}/api/files/x.oga`,
    );
  });

  it("URL que já é pública passa igual", () => {
    const ja = `${BASE}/api/files/x.oga`;
    expect(publicWahaMediaUrl(ja, BASE)).toBe(ja);
  });

  it("caminho de forma desconhecida volta cru (não perder a URL)", () => {
    const outro = "http://localhost:3000/media/v2/x.oga";
    expect(publicWahaMediaUrl(outro, BASE)).toBe(outro);
  });

  it("null e vazio não viram string", () => {
    expect(publicWahaMediaUrl(null, BASE)).toBeNull();
    expect(publicWahaMediaUrl(undefined, BASE)).toBeNull();
    expect(publicWahaMediaUrl("", BASE)).toBeNull();
  });

  it("string que não é URL volta crua em vez de explodir", () => {
    expect(publicWahaMediaUrl("nao-e-url", BASE)).toBe("nao-e-url");
  });
});
