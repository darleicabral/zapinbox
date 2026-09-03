/**
 * @vitest-environment node
 *
 * Regressão: o bot lia as falas do corretor como se fossem dele.
 *
 * `loadHistoryWithBudget` mapeava TODA mensagem de saída como `role: "assistant"`,
 * inclusive as digitadas por um corretor humano. Medido em produção (03/09/2026,
 * conversa 2c699951): o bot mandou "*Gilvam:* O consultor vai atender você no
 * número 31 99295-3088" — copiou o prefixo do corretor e se passou por uma pessoa
 * da equipe na frente da cliente. Na mesma conversa escreveu "Desculpa, me perdi
 * um pouco no fio aqui 😅", porque as "próprias" mensagens não batiam com a
 * política dele.
 */
import { describe, expect, it } from "vitest";

import { isHumanSent, splitSenderPrefix, toHistoryTurn } from "@/lib/ai/runtime/history";

describe("splitSenderPrefix", () => {
  it("tira o prefixo que o composer do CRM coloca", () => {
    expect(splitSenderPrefix("*Gilvam:* Essa oportunidade pode ser financiada.")).toEqual({
      sender: "Gilvam",
      body: "Essa oportunidade pode ser financiada.",
    });
  });

  it("texto sem prefixo passa intacto", () => {
    expect(splitSenderPrefix("Olá, tudo bem?")).toEqual({ sender: null, body: "Olá, tudo bem?" });
  });

  it("não confunde negrito no meio da frase com prefixo de autor", () => {
    expect(splitSenderPrefix("Olha esse *imóvel:* é ótimo").sender).toBeNull();
  });
});

describe("isHumanSent", () => {
  it("user e external_device são humanos", () => {
    expect(isHumanSent("user")).toBe(true);
    expect(isHumanSent("external_device")).toBe(true);
  });

  it("ai, system e legado (null) contam como plataforma", () => {
    expect(isHumanSent("ai")).toBe(false);
    expect(isHumanSent("system")).toBe(false);
    expect(isHumanSent(null)).toBe(false);
    expect(isHumanSent(undefined)).toBe(false);
  });
});

describe("toHistoryTurn: o modelo tem de saber quem escreveu", () => {
  it("mensagem do lead vira turno de user", () => {
    expect(toHistoryTurn({ body: "Gostei o preço", direction: "inbound" })).toEqual({
      role: "user",
      content: "Gostei o preço",
    });
  });

  it("mensagem do próprio bot fica limpa, sem rótulo", () => {
    expect(toHistoryTurn({ body: "Qual dia fica melhor?", direction: "outbound", sent_via: "ai" })).toEqual({
      role: "assistant",
      content: "Qual dia fica melhor?",
    });
  });

  it("mensagem do corretor é rotulada e perde o prefixo (o bug do *Gilvam:*)", () => {
    const t = toHistoryTurn({
      body: "*Gilvam:* O consultor vai atender você no número 31 99295-3088.",
      direction: "outbound",
      sent_via: "user",
    });
    expect(t.role).toBe("assistant");
    expect(t.content).toContain("não foi você");
    expect(t.content).toContain("o corretor Gilvam");
    expect(t.content).toContain("O consultor vai atender você no número 31 99295-3088.");
    // o formato que ele copiou não pode sobrar no histórico
    expect(t.content).not.toContain("*Gilvam:*");
  });

  it("corretor pelo celular, sem prefixo de nome, ainda é rotulado", () => {
    const t = toHistoryTurn({ body: "ja esta pronto sim", direction: "outbound", sent_via: "external_device" });
    expect(t.content).toContain("um corretor da equipe");
    expect(t.content).toContain("ja esta pronto sim");
  });

  it("body nulo não quebra", () => {
    expect(toHistoryTurn({ body: null, direction: "outbound", sent_via: "ai" }).content).toBe("");
  });
});
