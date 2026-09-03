/**
 * @vitest-environment node
 *
 * Regressão: TODO handoff tem de atribuir um corretor e avisar.
 *
 * Até 02/09/2026 a atribuição + aviso viviam dentro da tool
 * `crm_request_human_handoff`, então só o handoff decidido pela IA notificava
 * alguém. Os outros três gatilhos que chamam `triggerHandoff` (sentinela de texto
 * do lead, worker de sentimento e o ai-response-worker legado) silenciavam a
 * conversa e não avisavam ninguém: o lead digitava "quero falar com atendente",
 * o bot calava, e o corretor nunca sabia que tinha alguém esperando.
 *
 * Aqui testamos o `assignAndNotify` (lib/attendance/assign.ts), que o
 * orquestrador passou a chamar. O duplo do Supabase aplica os filtros e guarda
 * os updates, pra o teste falhar de verdade se a lógica mudar.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const notificados: Array<{ conversationId: string; assigneeUserId: string; kind: string }> = [];
vi.mock("@/lib/attendance/notify", () => ({
  notifyAssigneeNewLead: vi.fn(
    async (_c: unknown, args: { conversationId: string; assigneeUserId: string; kind: string }) => {
      notificados.push({
        conversationId: args.conversationId,
        assigneeUserId: args.assigneeUserId,
        kind: args.kind,
      });
      return true;
    },
  ),
}));

let rodizioLigado = false;
let escolhidoPeloRodizio: string | null = null;
vi.mock("@/lib/attendance/rotation", () => ({
  loadAttendanceSettings: vi.fn(async () => (rodizioLigado ? { enabled: true } : { enabled: false })),
  pickNextAssignee: vi.fn(async () => escolhidoPeloRodizio),
}));

vi.mock("@/lib/auth/admin-users", () => ({
  listAuthUsersByIds: vi.fn(async (_c: unknown, ids: string[]) => [
    { id: ids[0], raw_user_meta_data: { full_name: "Gilvam Souza" } },
  ]),
}));

const ORG = "org-1";
const CONV = "conv-1";

type Linha = Record<string, unknown>;
let conversas: Linha[] = [];
let membros: Linha[] = [];
const updates: Linha[] = [];

/** Builder mínimo do supabase-js que APLICA os filtros e registra os updates. */
function fakeFrom(tabela: string) {
  const fonte = tabela === "conversations" ? conversas : membros;
  let atual = [...fonte];
  let payload: Linha | null = null;
  const api: Record<string, unknown> = {
    select: () => api,
    update: (p: Linha) => {
      payload = p;
      return api;
    },
    eq: (col: string, val: unknown) => {
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
    maybeSingle: async () => {
      if (payload) {
        for (const r of atual) {
          updates.push({ tabela, id: r.id, ...payload });
          Object.assign(r, payload);
        }
        return { data: null, error: null };
      }
      return { data: atual[0] ?? null, error: null };
    },
    then<T>(resolve: (v: { data: Linha[] | null; error: null }) => T) {
      if (payload) {
        for (const r of atual) {
          updates.push({ tabela, id: r.id, ...payload });
          Object.assign(r, payload);
        }
        return Promise.resolve({ data: null, error: null }).then(resolve);
      }
      return Promise.resolve({ data: atual, error: null }).then(resolve);
    },
  };
  return api;
}
const cliente = { from: (t: string) => fakeFrom(t) } as never;

describe("assignAndNotify: todo handoff atribui e avisa", () => {
  beforeEach(() => {
    notificados.length = 0;
    updates.length = 0;
    rodizioLigado = false;
    escolhidoPeloRodizio = null;
    conversas = [{ id: CONV, organization_id: ORG, assigned_to_user_id: null }];
    membros = [
      { user_id: "u-bbb", organization_id: ORG, role: "agent", revoked_at: null },
      { user_id: "u-aaa", organization_id: ORG, role: "manager", revoked_at: null },
    ];
  });

  it("sem rodízio: atribui o primeiro elegível e avisa", async () => {
    const { assignAndNotify } = await import("@/lib/attendance/assign");

    const r = await assignAndNotify(cliente, { organizationId: ORG, conversationId: CONV });

    expect(r.assignedUserId).toBe("u-aaa"); // determinístico por user_id
    expect(r.rotationActive).toBe(false);
    expect(r.keptExistingAssignee).toBe(false);
    expect(r.assignedFirstName).toBe("Gilvam");
    expect(notificados).toEqual([{ conversationId: CONV, assigneeUserId: "u-aaa", kind: "assigned" }]);
    expect(updates.some((u) => u.assigned_to_user_id === "u-aaa")).toBe(true);
  });

  it("com rodízio: usa quem o rodízio escolheu e marca o 1º repasse do SLA", async () => {
    rodizioLigado = true;
    escolhidoPeloRodizio = "u-online";
    const { assignAndNotify } = await import("@/lib/attendance/assign");

    const r = await assignAndNotify(cliente, { organizationId: ORG, conversationId: CONV });

    expect(r.assignedUserId).toBe("u-online");
    expect(r.rotationActive).toBe(true);
    expect(updates.some((u) => u.assignment_passes === 1)).toBe(true);
    expect(notificados).toHaveLength(1);
  });

  it("conversa que já tem dono: avisa o dono e NÃO reatribui", async () => {
    conversas = [{ id: CONV, organization_id: ORG, assigned_to_user_id: "u-dono" }];
    const { assignAndNotify } = await import("@/lib/attendance/assign");

    const r = await assignAndNotify(cliente, { organizationId: ORG, conversationId: CONV });

    expect(r.assignedUserId).toBe("u-dono");
    expect(r.keptExistingAssignee).toBe(true);
    expect(notificados).toEqual([{ conversationId: CONV, assigneeUserId: "u-dono", kind: "assigned" }]);
    // roubar atendimento em andamento é pior que não avisar
    expect(updates.filter((u) => "assigned_to_user_id" in u)).toHaveLength(0);
  });

  it("rodízio sem corretor elegível na org: fila sem dono, e não inventa aviso", async () => {
    rodizioLigado = true;
    escolhidoPeloRodizio = null;
    const { assignAndNotify } = await import("@/lib/attendance/assign");

    const r = await assignAndNotify(cliente, { organizationId: ORG, conversationId: CONV });

    expect(r.assignedUserId).toBeNull();
    expect(r.assignedFirstName).toBeNull();
    expect(r.rotationActive).toBe(true);
    expect(notificados).toHaveLength(0);
  });

  it("conversa de outra org não é tocada", async () => {
    const { assignAndNotify } = await import("@/lib/attendance/assign");

    const r = await assignAndNotify(cliente, { organizationId: "org-outra", conversationId: CONV });

    expect(r.assignedUserId).toBeNull();
    expect(notificados).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });
});
