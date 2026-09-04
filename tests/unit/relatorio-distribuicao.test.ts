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
 *
 * ⚠️ NÃO mede resposta do corretor, de propósito. O Darlei cortou a primeira
 * versão: "cada corretor atende do seu próprio WhatsApp. Não temos como
 * registrar isso". O CRM só vê o que passa pelo número da imobiliária, então
 * "sem resposta" mediria ausência de dado, não abandono.
 */
import { describe, expect, it } from "vitest";

import { computeDistribuicao, type Corretor } from "@/lib/reports/distribuicao";

const EQUIPE: Corretor[] = [
  { userId: "u-gilvam", nome: "Gilvam Carvalho", semTelefone: false },
  { userId: "u-robson", nome: "Robson Gimenez", semTelefone: false },
  { userId: "u-novato", nome: "Novato Sem Zap", semTelefone: true },
];
const DESDE = "2026-09-04T03:00:00Z";
const em = (id: string, dono: string | null, quando: string | null) => ({
  id,
  assigned_to_user_id: dono,
  assigned_at: quando,
});

describe("computeDistribuicao", () => {
  it("conta quantos leads cada corretor recebeu", () => {
    const r = computeDistribuicao(
      [
        em("c1", "u-gilvam", "2026-09-04T12:00:00Z"),
        em("c2", "u-gilvam", "2026-09-04T12:10:00Z"),
        em("c3", "u-robson", "2026-09-04T12:20:00Z"),
      ],
      EQUIPE,
      DESDE,
    );
    expect(r.total).toBe(3);
    expect(r.corretores.find((c) => c.userId === "u-gilvam")!.recebidos).toBe(2);
    expect(r.corretores.find((c) => c.userId === "u-robson")!.recebidos).toBe(1);
    expect(r.corretores.find((c) => c.userId === "u-novato")!.recebidos).toBe(0);
  });

  it("calcula a fatia de cada um", () => {
    const r = computeDistribuicao(
      [
        em("a", "u-gilvam", "2026-09-04T12:00:00Z"),
        em("b", "u-gilvam", "2026-09-04T12:00:00Z"),
        em("c", "u-gilvam", "2026-09-04T12:00:00Z"),
        em("d", "u-robson", "2026-09-04T12:00:00Z"),
      ],
      EQUIPE,
      DESDE,
    );
    expect(r.corretores.find((c) => c.userId === "u-gilvam")!.fatiaPct).toBe(75);
    expect(r.corretores.find((c) => c.userId === "u-robson")!.fatiaPct).toBe(25);
  });

  it("corretor sem lead aparece com zero, não desaparece", () => {
    const r = computeDistribuicao([], EQUIPE, DESDE);
    expect(r.corretores).toHaveLength(3);
    expect(r.corretores.every((c) => c.recebidos === 0 && c.fatiaPct === 0)).toBe(true);
    expect(r.total).toBe(0);
  });

  it("marca quem não tem telefone de aviso (recebe no CRM, não no zap)", () => {
    const r = computeDistribuicao([], EQUIPE, DESDE);
    expect(r.corretores.find((c) => c.userId === "u-novato")!.semTelefone).toBe(true);
  });

  it("lead atribuído a quem saiu da equipe vira 'foraDaEquipe', não some", () => {
    const r = computeDistribuicao([em("c9", "u-demitido", "2026-09-04T12:00:00Z")], EQUIPE, DESDE);
    expect(r.total).toBe(1);
    expect(r.foraDaEquipe).toBe(1);
    expect(r.corretores.every((c) => c.recebidos === 0)).toBe(true);
  });

  it("conversa sem dono ou sem data é ignorada", () => {
    const r = computeDistribuicao(
      [em("x", null, "2026-09-04T12:00:00Z"), em("y", "u-gilvam", null)],
      EQUIPE,
      DESDE,
    );
    expect(r.total).toBe(0);
  });

  it("ordena por volume e desempata por nome (painel não pode dançar)", () => {
    const r = computeDistribuicao(
      [em("1", "u-robson", "2026-09-04T12:00:00Z"), em("2", "u-gilvam", "2026-09-04T12:00:00Z")],
      EQUIPE,
      DESDE,
    );
    // empate em 1: Gilvam antes de Robson
    expect(r.corretores.map((c) => c.userId)).toEqual(["u-gilvam", "u-robson", "u-novato"]);
  });
});
