/**
 * @vitest-environment node
 *
 * 03/09/2026 — o número do Cleber (corretor) estava listado como LEAD no inbox
 * da Avant. O CRM manda o aviso de lead pro WhatsApp dele, o WAHA devolve o eco
 * (fromMe), o ingest cria contato + conversa, a conversa nasce `pending` e o
 * vigia de SLA a repassa pra outro corretor — que recebe outro aviso. Laço.
 *
 * A comparação de telefone é a parte que erra fácil: o telefone de aviso é
 * digitado no formato novo (13 dígitos, com o 9) e o contato nasce do JID real
 * do WhatsApp, que em conta anterior a 2012 vem sem o 9 (12 dígitos).
 */
import { describe, expect, it } from "vitest";

import {
  digitosDeTelefone,
  ehTelefoneDaEquipe,
  variantesDeTelefone,
} from "@/lib/attendance/interno";

describe("digitosDeTelefone", () => {
  it("tira máscara e mantém só dígito", () => {
    expect(digitosDeTelefone("+55 (31) 99283-1280")).toBe("5531992831280");
  });

  it("recusa o que não é telefone", () => {
    expect(digitosDeTelefone(null)).toBeNull();
    expect(digitosDeTelefone("")).toBeNull();
    expect(digitosDeTelefone("123")).toBeNull();
    expect(digitosDeTelefone("9".repeat(16))).toBeNull();
  });
});

describe("variantesDeTelefone: o nono dígito", () => {
  it("formato novo gera também a forma sem o 9", () => {
    expect(variantesDeTelefone("+5531992831280")).toEqual(["5531992831280", "553192831280"]);
  });

  it("formato antigo gera também a forma com o 9", () => {
    expect(variantesDeTelefone("553192831280")).toEqual(["553192831280", "5531992831280"]);
  });

  it("celular que não começa com 9 depois do DDD não inventa variante", () => {
    // 55 + 31 + 8 dígitos começando em 8: nada a remover
    expect(variantesDeTelefone("5531884079999")).toEqual(["5531884079999"]);
  });

  it("sem telefone, lista vazia", () => {
    expect(variantesDeTelefone(null)).toEqual([]);
  });
});

describe("ehTelefoneDaEquipe", () => {
  // como o telefone de aviso foi cadastrado (formato novo)
  const equipe = new Set(["5531992831280", "553192831280", "5531984407819", "553184407819"]);

  it("reconhece o contato que nasceu SEM o nono dígito", () => {
    // este é o caso real: contato +553192831280, cadastro +5531992831280
    expect(ehTelefoneDaEquipe("+553192831280", equipe)).toBe(true);
  });

  it("reconhece também no formato novo", () => {
    expect(ehTelefoneDaEquipe("+5531984407819", equipe)).toBe(true);
  });

  it("lead comum não é confundido com a equipe", () => {
    expect(ehTelefoneDaEquipe("+553188935314", equipe)).toBe(false);
    expect(ehTelefoneDaEquipe("+553197777465", equipe)).toBe(false);
  });

  it("equipe sem telefone cadastrado não marca ninguém", () => {
    expect(ehTelefoneDaEquipe("+553192831280", new Set())).toBe(false);
  });

  it("contato sem telefone não casa", () => {
    expect(ehTelefoneDaEquipe(null, equipe)).toBe(false);
  });
});
