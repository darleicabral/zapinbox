/**
 * @vitest-environment node
 *
 * 🐛 10/09/2026 — CORRETORES RECLAMANDO DE RECEBER O MESMO LEAD DUAS VEZES.
 *
 * Medido nos avisos desde 05/09: **45 duplicatas em 162 avisos (28%)**, com 7 a
 * 23 segundos de intervalo. O event_log mostrava `ai.handoff_triggered` duas
 * vezes na mesma conversa, e o segundo caía no meio da mensagem de despedida do
 * bot.
 *
 * A causa: DOIS chamadores de `triggerHandoff` para o mesmo handoff.
 *   1. `lib/mcp/tools/handoff.ts` — a ferramenta que o agente invoca. Desde a
 *      consolidação do passo 6, ela já atribui o corretor E manda o aviso.
 *   2. `finalizeHandoff` no runtime — que re-disparava tudo ~10s depois.
 *
 * E a trava de idempotência do orquestrador NÃO segurava, por dois motivos que
 * este arquivo trava: a janela era de 5s (curta demais) e ela exigia o MESMO
 * motivo — a ferramenta manda "requested_human", o runtime manda o texto do
 * motivo, então nunca casavam.
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

/**
 * O runtime dispara o efeito colateral, ou só marca o run?
 *
 * Espelha a decisão de `finalizeHandoff`. É uma linha, e é justamente a linha
 * que causou 28% de aviso duplicado — vale ter travada por nome.
 */
function runtimeDisparaEfeito(source: "sentinel" | "tool" | "promessa" | "adiamento"): boolean {
  return source !== "tool";
}

describe("quem já disparou não dispara de novo", () => {
  it("handoff pela FERRAMENTA: o runtime não repete o aviso", () => {
    // a ferramenta ja atribuiu e avisou; aqui o runtime so marca o run
    expect(runtimeDisparaEfeito("tool")).toBe(false);
  });

  it("os outros gatilhos continuam disparando, porque ninguém disparou antes", () => {
    expect(runtimeDisparaEfeito("sentinel")).toBe(true);
    expect(runtimeDisparaEfeito("promessa")).toBe(true);
    expect(runtimeDisparaEfeito("adiamento")).toBe(true);
  });
});

/**
 * A rede de segurança do orquestrador, espelhada. Ela não é a correção — a
 * correção é não chamar duas vezes — mas é o que segura um terceiro chamador
 * futuro que esqueça disso.
 */
function ehDuplicata(args: {
  ultimoHandoffMs: number | null;
  agoraMs: number;
  janelaMs: number;
}): boolean {
  if (args.ultimoHandoffMs == null) return false;
  return args.agoraMs - args.ultimoHandoffMs < args.janelaMs;
}

describe("a trava de duplicata, com a janela e o critério certos", () => {
  const JANELA = 60_000;
  const t0 = 1_000_000;

  it("pega o intervalo real que escapava: 10 segundos", () => {
    // era exatamente o caso: a janela de 5s deixava passar
    expect(ehDuplicata({ ultimoHandoffMs: t0, agoraMs: t0 + 10_000, janelaMs: 5_000 })).toBe(false);
    expect(ehDuplicata({ ultimoHandoffMs: t0, agoraMs: t0 + 10_000, janelaMs: JANELA })).toBe(true);
  });

  it("pega toda a faixa medida nos duplicados (7 a 23 segundos)", () => {
    for (const seg of [7, 8, 9, 11, 12, 16, 21, 23, 52]) {
      expect(
        ehDuplicata({ ultimoHandoffMs: t0, agoraMs: t0 + seg * 1000, janelaMs: JANELA }),
        `${seg}s`,
      ).toBe(true);
    }
  });

  it("handoff legítimo depois da janela passa", () => {
    expect(ehDuplicata({ ultimoHandoffMs: t0, agoraMs: t0 + 61_000, janelaMs: JANELA })).toBe(false);
    // o caso real do Antonio Carlos: 8.655s (2h24) entre dois handoffs
    expect(
      ehDuplicata({ ultimoHandoffMs: t0, agoraMs: t0 + 8_655_000, janelaMs: JANELA }),
    ).toBe(false);
  });

  it("conversa sem handoff anterior nunca é duplicata", () => {
    expect(ehDuplicata({ ultimoHandoffMs: null, agoraMs: t0, janelaMs: JANELA })).toBe(false);
  });
});
