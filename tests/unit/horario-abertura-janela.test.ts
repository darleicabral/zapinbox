/**
 * @vitest-environment node
 *
 * `minutosDesdeAberturaDaJanela` existe por causa do buraco descoberto em
 * 04/09/2026: lead que escreve de madrugada nunca recebia follow-up. A trava de
 * idade media o silêncio desde a última mensagem dele, e às 9h um lead das 3h
 * já tinha 6 horas de silêncio. Contando a partir da ABERTURA do expediente ele
 * vira recém-chegado às 9h.
 *
 * Fuso importa: a Avant opera em America/Sao_Paulo (UTC-3), então 09:00 lá é
 * 12:00Z. Todos os instantes aqui são UTC explícito.
 */
import { describe, expect, it } from "vitest";

import { minutosDesdeAberturaDaJanela } from "@/lib/attendance/rotation";

/** A configuração real da Avant. */
const AVANT = {
  timezone: "America/Sao_Paulo",
  windows: [
    { days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" },
    { days: [6], start: "09:00", end: "12:00" },
  ],
};

const em = (iso: string) => new Date(iso);

describe("minutosDesdeAberturaDaJanela", () => {
  it("9h em ponto de uma sexta: acabou de abrir", () => {
    expect(minutosDesdeAberturaDaJanela(AVANT, em("2026-09-04T12:00:00Z"))).toBe(0);
  });

  it("meio-dia de sexta: 3 horas de expediente", () => {
    expect(minutosDesdeAberturaDaJanela(AVANT, em("2026-09-04T15:00:00Z"))).toBe(180);
  });

  it("17h59 de sexta ainda conta (dentro da janela)", () => {
    expect(minutosDesdeAberturaDaJanela(AVANT, em("2026-09-04T20:59:00Z"))).toBe(539);
  });

  it("madrugada devolve null: não há expediente aberto", () => {
    expect(minutosDesdeAberturaDaJanela(AVANT, em("2026-09-04T06:30:00Z"))).toBeNull();
  });

  it("depois das 18h devolve null", () => {
    expect(minutosDesdeAberturaDaJanela(AVANT, em("2026-09-04T21:30:00Z"))).toBeNull();
  });

  it("sábado usa a janela do sábado (9h-12h)", () => {
    expect(minutosDesdeAberturaDaJanela(AVANT, em("2026-09-05T13:00:00Z"))).toBe(60);
  });

  it("sábado depois das 12h já fechou", () => {
    expect(minutosDesdeAberturaDaJanela(AVANT, em("2026-09-05T16:00:00Z"))).toBeNull();
  });

  it("domingo não tem janela", () => {
    expect(minutosDesdeAberturaDaJanela(AVANT, em("2026-09-06T14:00:00Z"))).toBeNull();
  });

  it("sem configuração devolve null (a regra antiga vale sozinha)", () => {
    expect(minutosDesdeAberturaDaJanela(null, em("2026-09-04T12:00:00Z"))).toBeNull();
  });

  it("config legada (days/start/end na raiz) também funciona", () => {
    const legada = { timezone: "America/Sao_Paulo", days: [1, 2, 3, 4, 5], start: "08:00", end: "17:00" };
    expect(minutosDesdeAberturaDaJanela(legada, em("2026-09-04T12:00:00Z"))).toBe(60);
  });
});
