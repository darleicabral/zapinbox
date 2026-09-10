/**
 * @vitest-environment node
 *
 * Par do teste `handoff-atribui-e-avisa`: aquele prova que o assignAndNotify faz a
 * coisa certa, este prova que o ORQUESTRADOR o chama. Sem os dois, alguém pode
 * remover a chamada do passo 6 e o handoff volta a calar o bot sem avisar
 * ninguém, com os testes verdes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const chamadas: Array<Record<string, unknown>> = [];
vi.mock("@/lib/attendance/assign", () => ({
  assignAndNotify: vi.fn(async (_c: unknown, args: Record<string, unknown>) => {
    chamadas.push(args);
    return {
      assignedUserId: "u-gilvam",
      assignedFirstName: "Gilvam",
      rotationActive: true,
      keptExistingAssignee: false,
    };
  }),
}));

const CONV = "conv-1";
const ORG = "org-1";
let conversaExiste = true;
let ultimoHandoffAt: string | null = null;

/** Fake permissivo: o objetivo é só deixar o orquestrador chegar ao passo 6. */
function fakeAdmin() {
  return {
    from: () => {
      const api: Record<string, unknown> = {
        select: () => api,
        update: () => api,
        insert: async () => ({ error: null }),
        eq: () => api,
        maybeSingle: async () => ({
          data: conversaExiste
            ? {
                id: CONV,
                organization_id: ORG,
                last_handoff_at: ultimoHandoffAt,
                last_handoff_reason: "requested_human",
              }
            : null,
          error: null,
        }),
        then<T>(resolve: (v: { data: null; error: null }) => T) {
          return Promise.resolve({ data: null, error: null }).then(resolve);
        },
      };
      return api;
    },
    rpc: async () => ({ error: null }),
    channel: () => ({ send: async () => undefined }),
    removeChannel: async () => undefined,
  };
}
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fakeAdmin() }));

describe("triggerHandoff chama a atribuição+aviso", () => {
  beforeEach(() => {
    chamadas.length = 0;
    conversaExiste = true;
    ultimoHandoffAt = null;
  });

  it("no handoff por texto do lead (sentinela), atribui e avisa", async () => {
    const { triggerHandoff } = await import("@/lib/ai/handoff/orchestrator");

    const r = await triggerHandoff({
      conversationId: CONV,
      organizationId: ORG,
      reason: "requested_human",
      metadata: { source: "sentinel" },
    });

    expect(r.triggered).toBe(true);
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]).toMatchObject({ organizationId: ORG, conversationId: CONV });
    // o nome volta pro caller pra IA citar o corretor ao cliente
    expect(r.assignedFirstName).toBe("Gilvam");
    expect(r.assignedUserId).toBe("u-gilvam");
  });

  it("repassa o papel mínimo quando o caller pede (tool com suggested_assignee_role)", async () => {
    const { triggerHandoff } = await import("@/lib/ai/handoff/orchestrator");

    await triggerHandoff({
      conversationId: CONV,
      organizationId: ORG,
      reason: "requested_human",
      minAssigneeRole: "manager",
    });

    expect(chamadas[0]).toMatchObject({ minRole: "manager" });
  });

  it("handoff repetido na mesma conversa NAO atribui de novo", async () => {
    ultimoHandoffAt = new Date().toISOString();
    const { triggerHandoff } = await import("@/lib/ai/handoff/orchestrator");

    const r = await triggerHandoff({
      conversationId: CONV,
      organizationId: ORG,
      reason: "requested_human",
    });

    expect(r.triggered).toBe(false);
    expect(r.reason).toBe("idempotent");
    expect(chamadas).toHaveLength(0); // sem aviso em dobro
  });

  // 🐛 10/09/2026 — os corretores reclamaram de receber o mesmo lead duas vezes:
  // 45 duplicatas em 162 avisos. A trava nao pegava porque exigia o MESMO
  // motivo, e os dois caminhos mandam motivos diferentes (a ferramenta manda
  // "requested_human", o runtime manda o texto do motivo). Do ponto de vista do
  // corretor o motivo e irrelevante: dois avisos do mesmo lead em segundos sao
  // duplicata.
  it("motivo DIFERENTE na mesma conversa tambem e duplicata", async () => {
    ultimoHandoffAt = new Date(Date.now() - 10_000).toISOString(); // 10s atras
    const { triggerHandoff } = await import("@/lib/ai/handoff/orchestrator");

    const r = await triggerHandoff({
      conversationId: CONV,
      organizationId: ORG,
      reason: "low_sentiment", // outro motivo, mesma conversa
    });

    expect(r.triggered).toBe(false);
    expect(r.reason).toBe("idempotent");
    expect(chamadas).toHaveLength(0);
  });

  it("conversa inexistente não atribui", async () => {
    conversaExiste = false;
    const { triggerHandoff } = await import("@/lib/ai/handoff/orchestrator");

    const r = await triggerHandoff({
      conversationId: CONV,
      organizationId: ORG,
      reason: "low_sentiment",
    });

    expect(r.triggered).toBe(false);
    expect(chamadas).toHaveLength(0);
  });
});
