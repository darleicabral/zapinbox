/**
 * @vitest-environment node
 *
 * Incidente de 03/09/2026: ligar o reengajamento sobre o acervo disparou **116
 * mensagens em 34 conversas em 5 minutos**. Três causas:
 *
 *  1. Todas as conversas estavam paradas há horas, então TODAS já tinham cruzado
 *     os 5min da 1ª etapa no instante em que a cadência foi ligada.
 *  2. `after_minutes` mede o silêncio DO LEAD. Lead parado há dias tem TODAS as
 *     etapas vencidas ao mesmo tempo, e cada passada do cron mandava a próxima:
 *     a cadência inteira saía em minutos em vez de um dia. A Norma recebeu 5.
 *  3. O código enviava e só depois avançava a etapa, então duas passadas
 *     concorrentes do cron mandavam a MESMA frase (a Norma recebeu uma delas 3x
 *     em 35 segundos). Isso virou reserva-antes-de-enviar no sweep, coberto pelo
 *     update condicional em followup_step.
 *
 * Aqui testamos as regras de tempo (1 e 2), que é o que dá pra isolar.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://exemplo.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "teste",
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    INTERNAL_SECRET: "teste",
  },
}));
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  conversaElegivelPorAtivacao,
  podeDisparar,
  type FollowupStep,
} from "@/lib/followup/followup";

// a cadência que o Darlei definiu
const CADENCIA: FollowupStep[] = [
  { after_minutes: 5, message: "Oi, ainda tá por aí?" },
  { after_minutes: 10, message: "Notei que você não pode responder no momento." },
  { after_minutes: 120, message: "Esse imóvel ainda tem ótimas condições." },
  { after_minutes: 1440, message: "Oi, {nome}! Voltando aqui." },
];

describe("podeDisparar: a 1ª etapa não ressuscita conversa velha", () => {
  it("lead sumiu há 6 min: dispara", () => {
    expect(podeDisparar(CADENCIA, 0, { inactivityMin: 6, desdeUltimoFollowupMin: null })).toBe(true);
  });

  it("lead sumiu há 3 min: ainda no prazo, não dispara", () => {
    expect(podeDisparar(CADENCIA, 0, { inactivityMin: 3, desdeUltimoFollowupMin: null })).toBe(false);
  });

  it("lead sumiu há 5 HORAS: não começa cadência (o caso do incidente)", () => {
    expect(podeDisparar(CADENCIA, 0, { inactivityMin: 300, desdeUltimoFollowupMin: null })).toBe(false);
  });

  it("lead sumiu há 3 dias: não começa", () => {
    expect(podeDisparar(CADENCIA, 0, { inactivityMin: 4320, desdeUltimoFollowupMin: null })).toBe(false);
  });

  it("na borda de 180 min ainda começa; um minuto depois, não", () => {
    expect(podeDisparar(CADENCIA, 0, { inactivityMin: 180, desdeUltimoFollowupMin: null })).toBe(true);
    expect(podeDisparar(CADENCIA, 0, { inactivityMin: 181, desdeUltimoFollowupMin: null })).toBe(false);
  });
});

describe("podeDisparar: as etapas seguintes respeitam o intervalo", () => {
  it("etapa 2 exige 5 min desde a etapa 1, não só os 10 de silêncio", () => {
    // lead parado há 4h: os 10min da etapa 2 estão vencidos, mas mandamos agora
    expect(podeDisparar(CADENCIA, 1, { inactivityMin: 240, desdeUltimoFollowupMin: 1 })).toBe(false);
    expect(podeDisparar(CADENCIA, 1, { inactivityMin: 240, desdeUltimoFollowupMin: 5 })).toBe(true);
  });

  it("etapa 3 exige 110 min desde a etapa 2 (120 − 10)", () => {
    expect(podeDisparar(CADENCIA, 2, { inactivityMin: 4320, desdeUltimoFollowupMin: 30 })).toBe(false);
    expect(podeDisparar(CADENCIA, 2, { inactivityMin: 4320, desdeUltimoFollowupMin: 110 })).toBe(true);
  });

  it("etapa 4 exige 22h desde a etapa 3 (1440 − 120)", () => {
    expect(podeDisparar(CADENCIA, 3, { inactivityMin: 10000, desdeUltimoFollowupMin: 600 })).toBe(false);
    expect(podeDisparar(CADENCIA, 3, { inactivityMin: 10000, desdeUltimoFollowupMin: 1320 })).toBe(true);
  });

  it("lead parado há dias NÃO recebe a cadência toda de uma vez", () => {
    // era exatamente isto que acontecia: uma etapa por passada do cron
    const semEspera = { inactivityMin: 4320, desdeUltimoFollowupMin: 1 };
    expect(podeDisparar(CADENCIA, 1, semEspera)).toBe(false);
    expect(podeDisparar(CADENCIA, 2, semEspera)).toBe(false);
    expect(podeDisparar(CADENCIA, 3, semEspera)).toBe(false);
  });

  it("a trava de idade NÃO se aplica às etapas seguintes (senão a de 24h nunca sairia)", () => {
    // 1440min de silêncio é muito mais que os 180 da trava, e tem de disparar
    expect(podeDisparar(CADENCIA, 3, { inactivityMin: 1440, desdeUltimoFollowupMin: 1320 })).toBe(true);
  });

  it("etapa inexistente não dispara", () => {
    expect(podeDisparar(CADENCIA, 9, { inactivityMin: 99999, desdeUltimoFollowupMin: 99999 })).toBe(false);
  });
});

describe("idade efetiva: lead da madrugada entra quando o expediente abre", () => {
  // 04/09/2026 — o corte de idade media o silêncio desde a última mensagem do
  // lead, então quem escrevia de madrugada NUNCA recebia cadência: às 9h já
  // estava com 6h de silêncio e a trava de 180min barrava. Foram 4 leads só na
  // noite de 03/09 (03h25 a 03h45). Agora a idade da etapa 0 é a MENOR entre o
  // silêncio do lead e o tempo desde a abertura do expediente.

  it("lead das 3h dispara às 9h em ponto (abertura = idade 0)", () => {
    expect(
      podeDisparar(CADENCIA, 0, {
        inactivityMin: 360,
        desdeUltimoFollowupMin: null,
        minutosDesdeAberturaMin: 0,
      }),
    ).toBe(true);
  });

  it("mas não vira passe livre: às 12h30 o mesmo lead já está velho de novo", () => {
    // 210 min desde a abertura > 180 da trava
    expect(
      podeDisparar(CADENCIA, 0, {
        inactivityMin: 570,
        desdeUltimoFollowupMin: null,
        minutosDesdeAberturaMin: 210,
      }),
    ).toBe(false);
  });

  it("na borda: 180 min depois da abertura ainda entra", () => {
    expect(
      podeDisparar(CADENCIA, 0, {
        inactivityMin: 540,
        desdeUltimoFollowupMin: null,
        minutosDesdeAberturaMin: 180,
      }),
    ).toBe(true);
  });

  it("lead do meio do expediente continua medido pelo próprio silêncio", () => {
    // escreveu 10h, agora 10h06: 6 min de silêncio, 66 desde a abertura
    expect(
      podeDisparar(CADENCIA, 0, {
        inactivityMin: 6,
        desdeUltimoFollowupMin: null,
        minutosDesdeAberturaMin: 66,
      }),
    ).toBe(true);
  });

  it("ainda respeita o prazo da etapa: 3 min de silêncio não dispara nem na abertura", () => {
    expect(
      podeDisparar(CADENCIA, 0, {
        inactivityMin: 3,
        desdeUltimoFollowupMin: null,
        minutosDesdeAberturaMin: 0,
      }),
    ).toBe(false);
  });

  it("sem janela configurada (null) mantém a regra antiga", () => {
    expect(
      podeDisparar(CADENCIA, 0, {
        inactivityMin: 360,
        desdeUltimoFollowupMin: null,
        minutosDesdeAberturaMin: null,
      }),
    ).toBe(false);
  });

  it("a abertura NÃO afrouxa as etapas seguintes", () => {
    // etapa 2 exige 110 min desde a etapa 1; abrir o expediente não pula isso
    expect(
      podeDisparar(CADENCIA, 2, {
        inactivityMin: 4320,
        desdeUltimoFollowupMin: 30,
        minutosDesdeAberturaMin: 0,
      }),
    ).toBe(false);
  });
});

describe("corte por ativação: só conversa criada depois entra", () => {
  const entra = conversaElegivelPorAtivacao;

  const ATIVACAO = "2026-09-03T17:00:00Z";

  it("conversa criada 1 min DEPOIS da ativação entra", () => {
    expect(entra("2026-09-03T17:01:00Z", ATIVACAO)).toBe(true);
  });

  it("conversa criada 1 min ANTES fica fora pra sempre (as 34 do incidente)", () => {
    expect(entra("2026-09-03T16:59:00Z", ATIVACAO)).toBe(false);
  });

  it("conversa criada no mesmo instante fica fora (corte exclusivo)", () => {
    expect(entra(ATIVACAO, ATIVACAO)).toBe(false);
  });

  it("conversa de dias antes fica fora, mesmo se o lead voltar a escrever", () => {
    // decisão do Darlei: o corte é a CRIAÇÃO da conversa, não a última mensagem
    expect(entra("2026-08-30T10:00:00Z", ATIVACAO)).toBe(false);
  });

  it("sem enabled_at (tenant legado) NADA entra — exige reativar", () => {
    expect(entra("2026-09-03T17:01:00Z", null)).toBe(false);
  });
});
