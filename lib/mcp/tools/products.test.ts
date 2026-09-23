import { describe, expect, it } from "vitest";

import { crmSearchCatalog } from "./products";

/**
 * Regressão do incidente 21/09/2026 (Santa Branca, imóvel #367).
 * O bot buscou "apartamento Santa Branca 530000" com max_price=530000 e limit=8,
 * e a busca devolvia os 8 MAIS BARATOS (409k–473k), escondendo o de 530k, porque
 * o empate de score desempatava por preço crescente. O bot então dizia ao lead
 * que "não tenho 530k". Agora o empate ordena por proximidade ao preço-alvo.
 */

type Row = {
  id: string;
  external_ref: string;
  title: string;
  description: string | null;
  kind: string;
  price_cents: number;
  currency: string;
  location: string;
  url: string;
  attributes: Record<string, unknown>;
  status: string;
  organization_id: string;
};

const SANTA_BRANCA: Array<[string, number]> = [
  ["96", 409000],
  ["170", 425000],
  ["80", 429900],
  ["116", 430000],
  ["16", 440000],
  ["121", 450000],
  ["318", 465000],
  ["321", 473000],
  ["319", 490000],
  ["367", 530000], // o que o lead queria
  ["322", 550000], // acima do teto → some com max_price=530000
  ["120", 555000],
];

const FIXTURE: Row[] = SANTA_BRANCA.map(([ref, reais]) => ({
  id: `id-${ref}`,
  external_ref: ref,
  title: `Apartamento 2 quartos com suíte - Santa Branca (${ref})`,
  description: null,
  kind: "imovel",
  price_cents: reais * 100,
  currency: "BRL",
  location: "Santa Branca, Belo Horizonte, Minas Gerais",
  url: `https://x/${ref}`,
  attributes: {},
  status: "active",
  organization_id: "org",
}));

/** Query-builder falso: encadeia e aplica os filtros que o handler usa. */
function fakeCtx(rows: Row[]) {
  const qb = {
    _rows: rows.slice(),
    select() {
      return this;
    },
    eq(col: string, val: unknown) {
      if (col === "status") this._rows = this._rows.filter((r) => r.status === val);
      if (col === "kind") this._rows = this._rows.filter((r) => r.kind === val);
      return this;
    },
    gte(col: string, val: number) {
      if (col === "price_cents") this._rows = this._rows.filter((r) => r.price_cents >= val);
      return this;
    },
    lte(col: string, val: number) {
      if (col === "price_cents") this._rows = this._rows.filter((r) => r.price_cents <= val);
      return this;
    },
    limit() {
      return Promise.resolve({ data: this._rows, error: null });
    },
  };
  return { supabase: { from: () => qb }, organizationId: "org" } as never;
}

describe("crm_search_catalog — ordenação por preço-alvo", () => {
  it("traz o imóvel de 530k em 1º quando o lead pede 530k (regressão #367)", async () => {
    const out = (await crmSearchCatalog.handler(
      { query: "apartamento Santa Branca 530000", max_price: 530000, kind: "imovel", limit: 8 },
      fakeCtx(FIXTURE),
    )) as { count: number; products: Array<{ ref: string | null; price: { amount: number } | null }> };

    const refs = out.products.map((p) => p.ref);
    expect(refs).toContain("367"); // antes sumia
    expect(refs[0]).toBe("367"); // agora é o mais próximo do alvo
    expect(refs).not.toContain("322"); // 550k acima do teto de 530k
    expect(refs).not.toContain("120"); // 555k acima do teto
  });

  it("sem preço, mantém o mais barato primeiro (comportamento antigo)", async () => {
    const out = (await crmSearchCatalog.handler(
      { query: "apartamento Santa Branca", limit: 8 },
      fakeCtx(FIXTURE),
    )) as { products: Array<{ ref: string | null }> };

    expect(out.products[0]?.ref).toBe("96"); // 409k, o mais barato
  });
});
