/**
 * @vitest-environment node
 *
 * (ambiente node de propósito: este teste não toca DOM, e o jsdom leva ~440s pra
 * subir nesta máquina, contra ~1s do node.)
 *
 * Regressão: desativar o agente na tela ("Ativo" = ai_agents.is_active) tem de
 * DESLIGAR o bot.
 *
 * Até 31/08/2026 não desligava: o loadCandidates do despachante filtrava só
 * archived_at/published_version_id, e apenas o workers/ai-response-worker.ts
 * (caminho legado) respeitava is_active. Como a tool crm_search_knowledge
 * resolve a KB com `.eq("is_active", true)`, um agente desativado que fosse
 * despachado responderia SEM base de conhecimento, falando no escuro em vez de
 * calar. Pior que não desligar.
 *
 * O duplo do Supabase abaixo APLICA os filtros de verdade sobre um array em
 * memória. Se fosse só registrar as chamadas, o teste passaria mesmo com o
 * filtro errado.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: { INTERNAL_SECRET: "teste", NEXT_PUBLIC_APP_URL: "http://localhost:3000" },
}));
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const SESSAO_ATUAL = "sessao-numero-novo";
const SESSAO_ANTIGA = "sessao-numero-morto";

type Linha = Record<string, unknown>;

let tabela: Linha[] = [];
let colunasPedidas = "";

/** Builder mínimo do supabase-js: encadeia filtros e resolve no await. */
function fakeQuery(rows: Linha[]) {
  let atual = [...rows];
  const api = {
    select(cols: string) {
      colunasPedidas = cols;
      return api;
    },
    eq(col: string, val: unknown) {
      atual = atual.filter((r) => r[col] === val);
      return api;
    },
    is(col: string, val: unknown) {
      atual = atual.filter((r) => (val === null ? r[col] === null || r[col] === undefined : r[col] === val));
      return api;
    },
    not(col: string, op: string, val: unknown) {
      if (op !== "is" || val !== null) throw new Error(`not(${op}) não implementado no duplo`);
      atual = atual.filter((r) => r[col] !== null && r[col] !== undefined);
      return api;
    },
    order(col: string, opts?: { ascending?: boolean }) {
      const dir = opts?.ascending === false ? -1 : 1;
      atual = [...atual].sort((a, b) => (String(a[col]) < String(b[col]) ? -dir : dir));
      return api;
    },
    then<T>(resolve: (v: { data: Linha[]; error: null }) => T) {
      return Promise.resolve({ data: atual, error: null }).then(resolve);
    },
  };
  return api;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: () => fakeQuery(tabela) }),
}));

function agente(over: Partial<Linha> & { id: string }): Linha {
  return {
    organization_id: "org-1",
    priority: 0,
    created_at: "2026-01-01T00:00:00Z",
    archived_at: null,
    published_version_id: "v-" + over.id,
    is_active: true,
    version: {
      id: "v-" + over.id,
      organization_id: "org-1",
      status: "published",
      channel_session_id: SESSAO_ATUAL,
      trigger_config: { events: ["message"] },
    },
    ...over,
  };
}

describe("loadCandidates: is_active desliga o bot", () => {
  beforeEach(() => {
    tabela = [];
    colunasPedidas = "";
  });

  it("não devolve agente desativado, mesmo com versão publicada na sessão certa", async () => {
    const { loadCandidates } = await import("@/lib/ai/dispatcher");
    tabela = [agente({ id: "desativado", is_active: false })];

    const achados = await loadCandidates("org-1", SESSAO_ATUAL);

    expect(achados).toHaveLength(0);
  });

  it("devolve o agente ativo", async () => {
    const { loadCandidates } = await import("@/lib/ai/dispatcher");
    tabela = [agente({ id: "ativo" })];

    const achados = await loadCandidates("org-1", SESSAO_ATUAL);

    expect(achados).toHaveLength(1);
    expect(achados[0]!.id).toBe("ativo");
  });

  it("entre dois agentes, entrega só o ativo", async () => {
    const { loadCandidates } = await import("@/lib/ai/dispatcher");
    tabela = [agente({ id: "desativado", is_active: false }), agente({ id: "ativo" })];

    const achados = await loadCandidates("org-1", SESSAO_ATUAL);

    expect(achados.map((a) => a.id)).toEqual(["ativo"]);
  });

  it("mantém as travas antigas: arquivado, sem versão publicada e sessão de outro número", async () => {
    const { loadCandidates } = await import("@/lib/ai/dispatcher");
    tabela = [
      agente({ id: "arquivado", archived_at: "2026-08-01T00:00:00Z" }),
      agente({ id: "sem-versao", published_version_id: null }),
      agente({
        id: "outro-numero",
        version: {
          id: "v-outro",
          organization_id: "org-1",
          status: "published",
          channel_session_id: SESSAO_ANTIGA,
          trigger_config: { events: ["message"] },
        },
      }),
    ];

    const achados = await loadCandidates("org-1", SESSAO_ATUAL);

    expect(achados).toHaveLength(0);
  });

  it("ainda pede a versão publicada no mesmo select (o join não foi perdido)", async () => {
    const { loadCandidates } = await import("@/lib/ai/dispatcher");
    tabela = [agente({ id: "ativo" })];

    await loadCandidates("org-1", SESSAO_ATUAL);

    expect(colunasPedidas).toContain("ai_agent_versions");
    expect(colunasPedidas).toContain("channel_session_id");
  });
});
