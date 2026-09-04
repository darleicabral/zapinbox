/**
 * @vitest-environment node
 *
 * Pedido do Darlei (04/09/2026): "quantos leads foram enviados (via
 * notificação) para cada um dos corretores", em tempo real.
 *
 * A fonte é `conversations.assigned_to_user_id` + `assigned_at`, e ela só é
 * confiável porque no mesmo dia o lead deixou de passar adiante: quem foi
 * atribuído é quem foi avisado, e continua sendo. Antes disso a "Cris" trocou
 * de dono 6 vezes em 28 minutos e qualquer contagem por corretor seria ficção.
 */
import { describe, expect, it } from "vitest";

import { computeDistribuicao, type Corretor } from "@/lib/reports/distribuicao";

const EQUIPE: Corretor[] = [
  { userId: "u-gilvam", nome: "Gilvam Carvalho", semTelefone: false },
  { userId: "u-robson", nome: "Robson Gimenez", semTelefone: false },
  { userId: "u-novato", nome: "Novato Sem Zap", semTelefone: true },
];
const DESDE = "2026-09-04T03:00:00Z";

describe("computeDistribuicao", () => {
  it("conta por corretor e separa quem respondeu", () => {
    const r = computeDistribuicao(
      [
        { id: "c1", assigned_to_user_id: "u-gilvam", assigned_at: "2026-09-04T12:00:00Z" },
        { id: "c2", assigned_to_user_id: "u-gilvam", assigned_at: "2026-09-04T12:10:00Z" },
        { id: "c3", assigned_to_user_id: "u-robson", assigned_at: "2026-09-04T12:20:00Z" },
      ],
      // só a c1 teve resposta humana
      [{ conversation_id: "c1", created_at: "2026-09-04T12:04:00Z" }],
      EQUIPE,
      DESDE,
    );
    expect(r.total).toBe(3);
    const gilvam = r.corretores.find((c) => c.userId === "u-gilvam")!;
    expect(gilvam.recebidos).toBe(2);
    expect(gilvam.respondidos).toBe(1);
    expect(gilvam.semResposta).toBe(1);
    expect(gilvam.medianaRespostaMin).toBe(4);
    const robson = r.corretores.find((c) => c.userId === "u-robson")!;
    expect(robson.recebidos).toBe(1);
    expect(robson.respondidos).toBe(0);
    expect(robson.medianaRespostaMin).toBeNull();
  });

  it("corretor sem lead aparece com zero, não desaparece", () => {
    const r = computeDistribuicao([], [], EQUIPE, DESDE);
    expect(r.corretores).toHaveLength(3);
    expect(r.corretores.every((c) => c.recebidos === 0)).toBe(true);
    expect(r.total).toBe(0);
  });

  it("marca quem não tem telefone de aviso (recebe no CRM, não no zap)", () => {
    const r = computeDistribuicao([], [], EQUIPE, DESDE);
    expect(r.corretores.find((c) => c.userId === "u-novato")!.semTelefone).toBe(true);
  });

  it("resposta ANTERIOR à atribuição não conta", () => {
    // mensagem de outro momento do atendimento inflaria o "respondidos"
    const r = computeDistribuicao(
      [{ id: "c1", assigned_to_user_id: "u-gilvam", assigned_at: "2026-09-04T12:00:00Z" }],
      [{ conversation_id: "c1", created_at: "2026-09-04T11:00:00Z" }],
      EQUIPE,
      DESDE,
    );
    const gilvam = r.corretores.find((c) => c.userId === "u-gilvam")!;
    expect(gilvam.respondidos).toBe(0);
    expect(gilvam.semResposta).toBe(1);
  });

  it("usa a PRIMEIRA resposta quando há várias", () => {
    const r = computeDistribuicao(
      [{ id: "c1", assigned_to_user_id: "u-robson", assigned_at: "2026-09-04T12:00:00Z" }],
      [
        { conversation_id: "c1", created_at: "2026-09-04T12:30:00Z" },
        { conversation_id: "c1", created_at: "2026-09-04T12:05:00Z" },
      ],
      EQUIPE,
      DESDE,
    );
    expect(r.corretores.find((c) => c.userId === "u-robson")!.medianaRespostaMin).toBe(5);
  });

  it("mediana, não média: um lead esquecido não distorce", () => {
    const r = computeDistribuicao(
      [
        { id: "a", assigned_to_user_id: "u-robson", assigned_at: "2026-09-04T12:00:00Z" },
        { id: "b", assigned_to_user_id: "u-robson", assigned_at: "2026-09-04T12:00:00Z" },
        { id: "c", assigned_to_user_id: "u-robson", assigned_at: "2026-09-04T12:00:00Z" },
      ],
      [
        { conversation_id: "a", created_at: "2026-09-04T12:02:00Z" }, // 2 min
        { conversation_id: "b", created_at: "2026-09-04T12:04:00Z" }, // 4 min
        { conversation_id: "c", created_at: "2026-09-04T18:00:00Z" }, // 360 min
      ],
      EQUIPE,
      DESDE,
    );
    // média seria 122; a mediana conta a rotina, não o caso perdido
    expect(r.corretores.find((c) => c.userId === "u-robson")!.medianaRespostaMin).toBe(4);
  });

  it("lead atribuído a quem saiu da equipe vira 'foraDaEquipe', não some", () => {
    const r = computeDistribuicao(
      [{ id: "c9", assigned_to_user_id: "u-demitido", assigned_at: "2026-09-04T12:00:00Z" }],
      [],
      EQUIPE,
      DESDE,
    );
    expect(r.total).toBe(1);
    expect(r.foraDaEquipe).toBe(1);
    expect(r.corretores.every((c) => c.recebidos === 0)).toBe(true);
  });

  it("conversa sem dono ou sem data é ignorada", () => {
    const r = computeDistribuicao(
      [
        { id: "x", assigned_to_user_id: null, assigned_at: "2026-09-04T12:00:00Z" },
        { id: "y", assigned_to_user_id: "u-gilvam", assigned_at: null },
      ],
      [],
      EQUIPE,
      DESDE,
    );
    expect(r.total).toBe(0);
  });

  it("ordena por volume e desempata por nome (painel não pode dançar)", () => {
    const r = computeDistribuicao(
      [
        { id: "1", assigned_to_user_id: "u-robson", assigned_at: "2026-09-04T12:00:00Z" },
        { id: "2", assigned_to_user_id: "u-gilvam", assigned_at: "2026-09-04T12:00:00Z" },
      ],
      [],
      EQUIPE,
      DESDE,
    );
    // empate em 1: Gilvam antes de Robson
    expect(r.corretores.map((c) => c.userId)).toEqual(["u-gilvam", "u-robson", "u-novato"]);
  });
});
