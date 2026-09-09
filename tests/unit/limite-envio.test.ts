/**
 * @vitest-environment node
 *
 * O freio de mão do número de WhatsApp.
 *
 * 🚨 O risco aqui não é erro de API, é BANIMENTO. O número da Avant é uma sessão
 * WAHA num número comum, não o canal oficial da Meta. Rajada de mensagem pra
 * muitos destinatários é o padrão que o WhatsApp lê como spam, e perder o número
 * significa perder o histórico de todas as conversas e o contato de todos os
 * leads.
 *
 * Medido no banco em 09/09/2026: a pior rajada foi de **51 mensagens em 1
 * minuto** (03/09 14h, o incidente do acervo), 187 em 5 min e 276 em uma hora.
 * Dia normal fica entre 150 e 280 mensagens, com pico de 33 numa hora.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://exemplo.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "teste",
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    INTERNAL_SECRET: "teste",
    // sem Redis de propósito: cai no contador em memória, que é o que dá pra
    // exercitar aqui. A mensagem de aviso do fallback é intencional.
    UPSTASH_REDIS_REST_URL: "",
    UPSTASH_REDIS_REST_TOKEN: "",
  },
}));

import {
  podeEnviarAgora,
  textoDoAlarmeDeTeto,
  TETO_POR_HORA,
  TETO_POR_MINUTO,
} from "@/lib/waha/limite-envio";

/** Sessão nova por teste: as janelas são por sessão, e é isso que isola. */
let n = 0;
function sessaoNova(): string {
  n += 1;
  return `teste-sessao-${n}-${Math.random().toString(36).slice(2)}`;
}

const AGORA = new Date("2026-09-09T18:00:00.000Z");

describe("teto por minuto", () => {
  it("libera até o teto e barra o excedente", async () => {
    const s = sessaoNova();
    for (let i = 1; i <= TETO_POR_MINUTO; i++) {
      const d = await podeEnviarAgora(s, AGORA);
      expect(d.liberado, `envio ${i}`).toBe(true);
    }
    const barrado = await podeEnviarAgora(s, AGORA);
    expect(barrado.liberado).toBe(false);
    expect(barrado.motivo).toBe("minuto");
  });

  it("a rajada de 51 em 1 minuto seria cortada no 12º", async () => {
    const s = sessaoNova();
    let passaram = 0;
    for (let i = 0; i < 51; i++) {
      if ((await podeEnviarAgora(s, AGORA)).liberado) passaram += 1;
    }
    expect(passaram).toBe(TETO_POR_MINUTO);
  });

  it("o minuto seguinte libera de novo", async () => {
    const s = sessaoNova();
    for (let i = 0; i <= TETO_POR_MINUTO; i++) await podeEnviarAgora(s, AGORA);
    const depois = new Date(AGORA.getTime() + 61_000);
    expect((await podeEnviarAgora(s, depois)).liberado).toBe(true);
  });
});

describe("teto por hora, que é o freio de verdade", () => {
  it("passa o dia normal sem barrar nada", async () => {
    // o pico real medido numa hora foi 33
    const s = sessaoNova();
    let passaram = 0;
    for (let i = 0; i < 33; i++) {
      const quando = new Date(AGORA.getTime() + i * 5_000); // ~12/min
      if ((await podeEnviarAgora(s, quando)).liberado) passaram += 1;
    }
    expect(passaram).toBe(33);
  });

  it("barra por HORA mesmo quando o minuto nunca estoura", async () => {
    const s = sessaoNova();
    // Um envio a cada 5s dá exatamente 12 por minuto, o teto do minuto sem
    // passar dele. Os 150 caem em ~12 minutos, dentro da mesma hora.
    for (let i = 0; i < TETO_POR_HORA; i++) {
      const quando = new Date(AGORA.getTime() + i * 5_000);
      const d = await podeEnviarAgora(s, quando);
      expect(d.motivo, `envio ${i}`).toBe("ok");
    }
    const barrado = await podeEnviarAgora(s, new Date(AGORA.getTime() + TETO_POR_HORA * 5_000));
    expect(barrado.liberado).toBe(false);
    expect(barrado.motivo).toBe("hora");
  });

  it("a hora tem prioridade sobre o minuto na explicação", async () => {
    // quando os dois estouram, o motivo reportado é o mais grave
    const s = sessaoNova();
    for (let i = 0; i < TETO_POR_HORA + 5; i++) await podeEnviarAgora(s, AGORA);
    const d = await podeEnviarAgora(s, AGORA);
    expect(d.motivo).toBe("hora");
  });
});

describe("as sessões não se atrapalham", () => {
  it("um número esgotado não bloqueia o outro", async () => {
    const a = sessaoNova();
    const b = sessaoNova();
    for (let i = 0; i <= TETO_POR_MINUTO; i++) await podeEnviarAgora(a, AGORA);
    expect((await podeEnviarAgora(a, AGORA)).liberado).toBe(false);
    expect((await podeEnviarAgora(b, AGORA)).liberado).toBe(true);
  });
});

describe("o alarme diz o que está acontecendo, não só que barrou", () => {
  it("no teto da hora, avisa que o envio PAROU e por quê", () => {
    const t = textoDoAlarmeDeTeto({ liberado: false, motivo: "hora", noMinuto: 3, naHora: 151 });
    expect(t).toContain("PARADO");
    expect(t).toContain("151");
    expect(t).toContain("banir o número");
  });

  it("no teto do minuto, avisa que foi rajada contida", () => {
    const t = textoDoAlarmeDeTeto({ liberado: false, motivo: "minuto", noMinuto: 13, naHora: 20 });
    expect(t).toContain("Rajada");
    expect(t).toContain("13");
  });
});
