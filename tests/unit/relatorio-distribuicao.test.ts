/**
 * @vitest-environment node
 *
 * Funil pedido pelo Darlei (04/09/2026): "quantos leads foram enviados (via
 * notificação) para cada um dos corretores" e, depois, "quantos leads chegaram
 * também... pra gente ter uma noção de quantos chegaram e quantos a IA
 * conseguiu mandar para o corretor".
 *
 * Duas coisas que os testes travam:
 *
 *  - o que NÃO é lead fica fora dos dois números: conversa do próprio corretor
 *    (nasce do eco do aviso) e conversa sem nenhuma mensagem do cliente. Se
 *    entrassem, a taxa de encaminhamento cairia sozinha e pareceria falha da IA.
 *
 *  - NÃO tem "respondeu". O Darlei cortou: "cada corretor atende do seu próprio
 *    WhatsApp. Não temos como registrar isso". O CRM só vê o que passa pelo
 *    número da imobiliária, então medir resposta seria medir ausência de dado.
 */
import { describe, expect, it } from "vitest";

import { computeDistribuicao, type Corretor } from "@/lib/reports/distribuicao";

const EQUIPE: Corretor[] = [
  { userId: "u-gilvam", nome: "Gilvam Carvalho", semTelefone: false },
  { userId: "u-robson", nome: "Robson Gimenez", semTelefone: false },
  { userId: "u-novato", nome: "Novato Sem Zap", semTelefone: true },
];
const DESDE = "2026-09-04T03:00:00Z";

/** lead(id, dono) — por padrão é lead de verdade: tem entrada e não é interno. */
const lead = (id: string, dono: string | null = null, extra: Partial<{ interno: boolean; temEntrada: boolean }> = {}) => ({
  id,
  assigned_to_user_id: dono,
  interno: extra.interno ?? false,
  temEntrada: extra.temEntrada ?? true,
});

describe("funil: chegaram x encaminhados", () => {
  it("conta os dois lados e a sobra sem corretor", () => {
    const r = computeDistribuicao(
      [lead("a", "u-gilvam"), lead("b", "u-robson"), lead("c"), lead("d")],
      EQUIPE,
      DESDE,
    );
    expect(r.chegaram).toBe(4);
    expect(r.encaminhados).toBe(2);
    expect(r.semCorretor).toBe(2);
  });

  it("conversa do próprio corretor não é lead (eco do aviso)", () => {
    const r = computeDistribuicao(
      [lead("a", "u-gilvam"), lead("interno", "u-robson", { interno: true })],
      EQUIPE,
      DESDE,
    );
    expect(r.chegaram).toBe(1);
    expect(r.encaminhados).toBe(1);
    expect(r.corretores.find((c) => c.userId === "u-robson")!.recebidos).toBe(0);
  });

  it("conversa sem mensagem do cliente não entra no funil", () => {
    // se entrasse, a taxa de encaminhamento cairia sozinha e pareceria falha da IA
    const r = computeDistribuicao(
      [lead("a", "u-gilvam"), lead("vazia", null, { temEntrada: false })],
      EQUIPE,
      DESDE,
    );
    expect(r.chegaram).toBe(1);
    expect(r.semCorretor).toBe(0);
  });

  it("tudo encaminhado: sobra zero", () => {
    const r = computeDistribuicao([lead("a", "u-gilvam"), lead("b", "u-gilvam")], EQUIPE, DESDE);
    expect(r.chegaram).toBe(2);
    expect(r.encaminhados).toBe(2);
    expect(r.semCorretor).toBe(0);
  });

  it("nada chegou: números zerados, sem divisão por zero", () => {
    const r = computeDistribuicao([], EQUIPE, DESDE);
    expect(r.chegaram).toBe(0);
    expect(r.encaminhados).toBe(0);
    expect(r.corretores.every((c) => c.fatiaPct === 0)).toBe(true);
  });
});

describe("por corretor", () => {
  it("conta quantos cada um recebeu", () => {
    const r = computeDistribuicao(
      [lead("c1", "u-gilvam"), lead("c2", "u-gilvam"), lead("c3", "u-robson")],
      EQUIPE,
      DESDE,
    );
    expect(r.corretores.find((c) => c.userId === "u-gilvam")!.recebidos).toBe(2);
    expect(r.corretores.find((c) => c.userId === "u-robson")!.recebidos).toBe(1);
    expect(r.corretores.find((c) => c.userId === "u-novato")!.recebidos).toBe(0);
  });

  it("a fatia é sobre o ENCAMINHADO, não sobre o que chegou", () => {
    // 4 chegaram, 2 encaminhados: quem levou 1 tem 50%, não 25%
    const r = computeDistribuicao(
      [lead("a", "u-gilvam"), lead("b", "u-robson"), lead("c"), lead("d")],
      EQUIPE,
      DESDE,
    );
    expect(r.corretores.find((c) => c.userId === "u-gilvam")!.fatiaPct).toBe(50);
    expect(r.corretores.find((c) => c.userId === "u-robson")!.fatiaPct).toBe(50);
  });

  it("corretor sem lead aparece com zero, não desaparece", () => {
    const r = computeDistribuicao([], EQUIPE, DESDE);
    expect(r.corretores).toHaveLength(3);
  });

  it("marca quem não tem telefone de aviso (recebe no CRM, não no zap)", () => {
    const r = computeDistribuicao([], EQUIPE, DESDE);
    expect(r.corretores.find((c) => c.userId === "u-novato")!.semTelefone).toBe(true);
  });

  it("encaminhado a quem saiu da equipe conta no funil e vira 'foraDaEquipe'", () => {
    const r = computeDistribuicao([lead("c9", "u-demitido")], EQUIPE, DESDE);
    expect(r.chegaram).toBe(1);
    expect(r.encaminhados).toBe(1);
    expect(r.foraDaEquipe).toBe(1);
    expect(r.corretores.every((c) => c.recebidos === 0)).toBe(true);
  });

  it("ordena por volume e desempata por nome (painel não pode dançar)", () => {
    const r = computeDistribuicao([lead("1", "u-robson"), lead("2", "u-gilvam")], EQUIPE, DESDE);
    expect(r.corretores.map((c) => c.userId)).toEqual(["u-gilvam", "u-robson", "u-novato"]);
  });
});
