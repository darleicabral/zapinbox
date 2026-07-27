/**
 * Unit tests for lib/contacts/csv.ts — parser da importação de contatos.
 *
 * Casos tirados de arquivo real (export do CVCRM da Itaville): separador `;`,
 * BOM, cabeçalho acentuado, célula `=HIPERLINK(...)` no nome e empreendimento
 * escrito como "VENDAS - RESIDENCIAL VAN GOGH".
 */

import { describe, it, expect } from "vitest";
import {
  dedupeRows,
  normalizeEmpreendimento,
  normalizePhone,
  parseContactsCsv,
  unwrapFormula,
} from "@/lib/contacts/csv";

const EMPREENDIMENTOS = ["Parque Olímpico 4", "Van Gogh", "Salvador Dalí", "Jardim Canaã"];

describe("normalizePhone", () => {
  it("assume Brasil quando vem sem país", () => {
    expect(normalizePhone("(33) 99872-2571")).toBe("+5533998722571");
    expect(normalizePhone("3332221111")).toBe("+553332221111");
  });

  it("preserva quem já veio com país", () => {
    expect(normalizePhone("+5533998722571")).toBe("+5533998722571");
    expect(normalizePhone("5533998722571")).toBe("+5533998722571");
    expect(normalizePhone("+351 912 345 678")).toBe("+351912345678");
  });

  it("descarta o que não dá pra discar", () => {
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone("98722571")).toBeNull(); // sem DDD
    expect(normalizePhone("-")).toBeNull();
  });
});

describe("unwrapFormula", () => {
  it("extrai o texto do =HIPERLINK do export", () => {
    expect(unwrapFormula('=HIPERLINK("https://x.com/y";"GS Logistica e Transportes")')).toBe(
      "GS Logistica e Transportes",
    );
  });

  it("deixa texto normal em paz", () => {
    expect(unwrapFormula("  Maria Silva ")).toBe("Maria Silva");
  });
});

describe("normalizeEmpreendimento", () => {
  it("casa o rótulo do arquivo com a opção cadastrada", () => {
    expect(normalizeEmpreendimento("VENDAS - RESIDENCIAL VAN GOGH", EMPREENDIMENTOS)).toBe(
      "Van Gogh",
    );
    expect(normalizeEmpreendimento("salvador dali", EMPREENDIMENTOS)).toBe("Salvador Dalí");
  });

  it("mantém o texto quando não há opção equivalente", () => {
    expect(normalizeEmpreendimento("Residencial Aurora", EMPREENDIMENTOS)).toBe("Aurora");
    expect(normalizeEmpreendimento("", EMPREENDIMENTOS)).toBeNull();
  });
});

describe("parseContactsCsv", () => {
  const csv = [
    '﻿"Data Venda";"Situação atual";Empreendimento;Unidade;Cliente;E-mail;Telefone',
    '02/10/2025;Distrato;"VENDAS - RESIDENCIAL VAN GOGH";1402;"=HIPERLINK(""https://x"";""GS Logistica"")";gs@exemplo.com;+5533998722571',
    '07/10/2025;Vendida;"VENDAS - RESIDENCIAL VAN GOGH";1602;Maria Silva;maria@exemplo.com;(33) 98888-7777',
    ";;;;;;",
  ].join("\r\n");

  it("detecta separador, BOM e mapeia os cabeçalhos conhecidos", () => {
    const out = parseContactsCsv(csv, { empreendimentos: EMPREENDIMENTOS });
    expect(out.mapping).toMatchObject({
      Empreendimento: "empreendimento",
      Cliente: "name",
      "E-mail": "email",
      Telefone: "phone",
    });
    expect(out.ignored).toContain("Data Venda");
    expect(out.headers[0]).toBe("Data Venda"); // BOM não gruda no 1º cabeçalho
  });

  it("normaliza as linhas e marca a linha vazia", () => {
    const { rows } = parseContactsCsv(csv, { empreendimentos: EMPREENDIMENTOS });
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      line: 2,
      name: "GS Logistica",
      email: "gs@exemplo.com",
      phone: "+5533998722571",
      empreendimento: "Van Gogh",
    });
    expect(rows[1]!.phone).toBe("+5533988887777");
    expect(rows[2]!.skipped).toBeTruthy();
  });

  it("não quebra em arquivo vazio", () => {
    expect(parseContactsCsv("").rows).toHaveLength(0);
  });
});

describe("dedupeRows", () => {
  it("remove repetição por telefone E por e-mail (unique do banco)", () => {
    const rows = [
      { line: 2, name: "A", phone: "+5511111111111", email: "a@x.com", empreendimento: null },
      { line: 3, name: "A de novo", phone: "+5511111111111", email: null, empreendimento: null },
      { line: 4, name: "Esposa", phone: "+5522222222222", email: "a@x.com", empreendimento: null },
      { line: 5, name: "Outro", phone: "+5533333333333", email: "b@x.com", empreendimento: null },
    ];
    const { unique, duplicates } = dedupeRows(rows);
    expect(duplicates).toBe(2);
    expect(unique.map((r) => r.line)).toEqual([2, 5]);
  });
});
