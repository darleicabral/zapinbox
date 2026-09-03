/**
 * @vitest-environment node
 *
 * Decisão do Darlei (03/09/2026): o DONO não entra no rodízio. Ele é admin e só
 * supervisiona, não atende lead. Antes era sorteado como qualquer um, e o bot
 * chegou a prometer ao cliente "vou te encaminhar pro Dono, nosso corretor" — o
 * nome dele no cadastro é literalmente "Dono".
 *
 * Cuidado com o que NÃO muda: gerente continua no rodízio (na Avant o Cleber é
 * manager e atende), e presença não filtra ninguém (corretor offline recebe o
 * aviso no WhatsApp e responde do próprio número).
 *
 * Reforçado no mesmo dia: "em nenhum momento, em hipótese alguma você
 * encaminhará para o dono. Ele não é corretor." Por isso a escalada do SLA
 * também deixou de cair no admin — ela ATRIBUI a conversa, não só avisa.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const ORG = "org-1";

type Linha = Record<string, unknown>;
let membros: Linha[] = [];
let settings: Linha | null = null;
const updates: Linha[] = [];

/** Duplo do supabase-js que aplica os filtros e guarda o update do ponteiro. */
function fakeFrom(tabela: string) {
  let atual: Linha[] = tabela === "user_organizations" ? [...membros] : settings ? [settings] : [];
  let payload: Linha | null = null;
  const api: Record<string, unknown> = {
    select: () => api,
    update: (p: Linha) => {
      payload = p;
      return api;
    },
    eq: (col: string, val: unknown) => {
      if (payload) return api; // update filtra por org, não precisa simular
      atual = atual.filter((r) => r[col] === val);
      return api;
    },
    is: (col: string, val: unknown) => {
      atual = atual.filter((r) => (val === null ? r[col] == null : r[col] === val));
      return api;
    },
    in: (col: string, vals: unknown[]) => {
      atual = atual.filter((r) => vals.includes(r[col] as never));
      return api;
    },
    order: (col: string) => {
      atual = [...atual].sort((a, b) => String(a[col]).localeCompare(String(b[col])));
      return api;
    },
    maybeSingle: async () => ({ data: atual[0] ?? null, error: null }),
    then<T>(resolve: (v: { data: Linha[] | null; error: null }) => T) {
      if (payload) {
        updates.push({ tabela, ...payload });
        return Promise.resolve({ data: null, error: null }).then(resolve);
      }
      return Promise.resolve({ data: atual, error: null }).then(resolve);
    },
  };
  return api;
}
const cliente = { from: (t: string) => fakeFrom(t) } as never;

describe("pickNextAssignee: o dono fica fora", () => {
  beforeEach(() => {
    updates.length = 0;
    settings = { organization_id: ORG, enabled: true, last_assigned_user_id: null };
    // ids escolhidos pra ordem alfabética ser previsível (o rodízio ordena por user_id)
    membros = [
      { user_id: "u1-agent-gilvam", organization_id: ORG, role: "agent", revoked_at: null },
      { user_id: "u2-admin-dono", organization_id: ORG, role: "admin", revoked_at: null },
      { user_id: "u3-manager-cleber", organization_id: ORG, role: "manager", revoked_at: null },
      { user_id: "u4-agent-robson", organization_id: ORG, role: "agent", revoked_at: null },
    ];
  });

  it("não escolhe o admin, mesmo sendo o primeiro da ordem depois do ponteiro", async () => {
    const { pickNextAssignee } = await import("@/lib/attendance/rotation");
    // ponteiro no gilvam: o próximo alfabético seria o admin
    const escolhido = await pickNextAssignee(cliente, ORG, { pointer: "u1-agent-gilvam" });
    expect(escolhido).toBe("u3-manager-cleber");
  });

  it("gerente CONTINUA no rodízio", async () => {
    const { pickNextAssignee } = await import("@/lib/attendance/rotation");
    const escolhido = await pickNextAssignee(cliente, ORG, { pointer: "u2-admin-dono" });
    expect(escolhido).toBe("u3-manager-cleber");
  });

  it("dá a volta circular passando por cima do admin", async () => {
    const { pickNextAssignee } = await import("@/lib/attendance/rotation");
    const escolhido = await pickNextAssignee(cliente, ORG, { pointer: "u4-agent-robson" });
    expect(escolhido).toBe("u1-agent-gilvam"); // volta ao início, sem parar no admin
  });

  it("org só com admin não atribui ninguém, e a escalada também não", async () => {
    membros = [{ user_id: "u2-admin-dono", organization_id: ORG, role: "admin", revoked_at: null }];
    const { pickNextAssignee } = await import("@/lib/attendance/rotation");
    expect(await pickNextAssignee(cliente, ORG, { pointer: null })).toBeNull();
  });

  it("avança o ponteiro pra quem foi escolhido", async () => {
    const { pickNextAssignee } = await import("@/lib/attendance/rotation");
    await pickNextAssignee(cliente, ORG, { pointer: "u1-agent-gilvam" });
    expect(updates.some((u) => u.last_assigned_user_id === "u3-manager-cleber")).toBe(true);
  });
});

describe("pickFallbackManager: a escalada NUNCA cai no dono", () => {
  beforeEach(() => {
    updates.length = 0;
    settings = { organization_id: ORG, enabled: true, last_assigned_user_id: null };
  });

  it("com gerente, a escalada vai pro gerente", async () => {
    membros = [
      { user_id: "u2-admin-dono", organization_id: ORG, role: "admin", revoked_at: null },
      { user_id: "u3-manager-cleber", organization_id: ORG, role: "manager", revoked_at: null },
    ];
    const { pickFallbackManager } = await import("@/lib/attendance/rotation");
    expect(await pickFallbackManager(cliente, ORG)).toBe("u3-manager-cleber");
  });

  it("SEM gerente, devolve null em vez de cair no admin", async () => {
    // "em nenhum momento, em hipótese alguma você encaminhará para o dono"
    // (Darlei, 03/09/2026). A escalada ATRIBUI a conversa, não só avisa — era
    // isso que fazia o bot prometer "vou te encaminhar pro Dono".
    membros = [
      { user_id: "u1-agent-gilvam", organization_id: ORG, role: "agent", revoked_at: null },
      { user_id: "u2-admin-dono", organization_id: ORG, role: "admin", revoked_at: null },
    ];
    const { pickFallbackManager } = await import("@/lib/attendance/rotation");
    expect(await pickFallbackManager(cliente, ORG)).toBeNull();
  });
});

describe("presença não filtra: corretor offline recebe do mesmo jeito", () => {
  beforeEach(() => {
    updates.length = 0;
    settings = { organization_id: ORG, enabled: true, last_assigned_user_id: null };
  });

  it("rodízio escolhe corretor OFFLINE (ele recebe o aviso no zap)", async () => {
    // pedido do Darlei: o corretor é mobile-first, responde do próprio número,
    // então estar com o CRM fechado não pode tirá-lo da fila.
    membros = [
      { user_id: "u1-agent-gilvam", organization_id: ORG, role: "agent", revoked_at: null, presence: "offline" },
      { user_id: "u4-agent-robson", organization_id: ORG, role: "agent", revoked_at: null, presence: "offline" },
    ];
    const { pickNextAssignee } = await import("@/lib/attendance/rotation");
    expect(await pickNextAssignee(cliente, ORG, { pointer: null })).toBe("u1-agent-gilvam");
  });

  it("escalada também ignora presença do gerente", async () => {
    membros = [
      { user_id: "u3-manager-cleber", organization_id: ORG, role: "manager", revoked_at: null, presence: "offline" },
    ];
    const { pickFallbackManager } = await import("@/lib/attendance/rotation");
    expect(await pickFallbackManager(cliente, ORG)).toBe("u3-manager-cleber");
  });
});
