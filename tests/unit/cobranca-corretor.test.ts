/**
 * @vitest-environment node
 *
 * Cobrar o corretor quando o lead volta a escrever e ele não respondeu (item 5
 * da lista de melhorias, 09/09/2026).
 *
 * O caso real: a Valone foi encaminhada ao Gilvam às 21h02 do dia 08 e voltou a
 * escrever três vezes na manhã seguinte, a última delas "Bom dia tenho
 * interesse, só que não me responde as mensagens". O bot fica calado depois do
 * handoff, a cadência para quando a conversa tem dono, e ninguém cutucava o
 * corretor.
 *
 * O texto foi ditado pelo Darlei; estes testes travam o formato dele.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://exemplo.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "teste",
    NEXT_PUBLIC_APP_URL: "https://crm.zapinbox.com.br",
    INTERNAL_SECRET: "teste",
  },
}));

import { leadReclamouDeAbandono } from "@/lib/ai/runtime/handoff";
import { quandoEncaminhei, textoDaCobranca } from "@/lib/attendance/recobrar";

describe("quando o corretor recebeu o lead", () => {
  // 09/09/2026 09:00 BRT = 12:00Z
  const AGORA = new Date("2026-09-09T12:00:00.000Z");

  it("o caso Valone: encaminhada 21h02 do dia 08, cobrada na manhã do dia 09", () => {
    expect(quandoEncaminhei("2026-09-09T00:02:00.000Z", AGORA)).toBe("no dia 08/09 às 21h02");
  });

  it("no mesmo dia diz 'hoje', que é mais útil que repetir a data", () => {
    // 09/09 07h30 BRT
    expect(quandoEncaminhei("2026-09-09T10:30:00.000Z", AGORA)).toBe("hoje às 07h30");
  });

  it("dia e mês com dois dígitos sempre, pra não sair '8/9'", () => {
    expect(quandoEncaminhei("2026-09-04T15:05:00.000Z", AGORA)).toBe("no dia 04/09 às 12h05");
  });
});

describe("o texto que chega no WhatsApp do corretor", () => {
  const base = {
    nomeDoLead: "Valone Malaquias",
    quando: "no dia 08/09 às 21h02",
    waLink: "https://wa.me/553189904922",
    crmLink: "https://crm.zapinbox.com.br/app/inbox/3afbf4ce",
  };

  it("segue o formato que o Darlei pediu", () => {
    const t = textoDaCobranca(base);
    expect(t).toContain("O lead *Valone Malaquias* que te encaminhei no dia 08/09 às 21h02");
    expect(t).toContain("reclamou de não ter sido contatado");
    expect(t).toContain("Clique e converse: https://wa.me/553189904922");
    expect(t).toContain("histórico: https://crm.zapinbox.com.br/app/inbox/3afbf4ce");
  });

  it("o link do WhatsApp vem antes do link do CRM", () => {
    const t = textoDaCobranca(base);
    // a ação é falar com o lead; ver o histórico é opcional
    expect(t.indexOf("wa.me")).toBeLessThan(t.indexOf("app/inbox"));
  });

  it("sem telefone do lead, o aviso ainda sai com o histórico", () => {
    const t = textoDaCobranca({ ...base, waLink: null });
    expect(t).not.toContain("Clique e converse");
    expect(t).toContain("app/inbox");
    expect(t).toContain("reclamou de não ter sido contatado");
  });

  it("não promete reatribuir: o lead nunca passa adiante", () => {
    const t = textoDaCobranca(base);
    expect(t).not.toMatch(/outro corretor|repassad|transferid/i);
  });
});

/**
 * 🐛 INCIDENTE 09/09/2026 — a primeira versao disparou 29 COBRANCAS na primeira
 * passada, de leads encaminhados havia ate 6,3 DIAS, e o Cleber reclamou.
 *
 * A premissa estava errada: "o lead voltou a escrever e o corretor nao respondeu
 * NO SISTEMA" nao mede nada, porque o corretor atende pelo celular DELE, fora do
 * numero compartilhado -- o CRM nunca ve essa resposta. Era o mesmo erro que o
 * Darlei ja tinha corrigido em 08/09 sobre o alerta de SLA.
 *
 * A fala do LEAD e a unica evidencia que nao depende de medir o corretor. E e
 * exatamente o que a mensagem afirma ("reclamou de nao ter sido contatado") --
 * antes disso, a mensagem mentia sobre o proprio gatilho.
 *
 * Medido nas 29 que sairam por engano: exigindo reclamacao sobra UMA.
 */
describe("a trava que derrubou 29 cobrancas para 1", () => {
  it("a UNICA que devia ter saido: a Valone reclamando", () => {
    expect(leadReclamouDeAbandono("Bom dia tenho interesse, só que não me responde as mensagens")).toBe(true);
  });

  it("as outras 28 nao reclamavam de nada", () => {
    // falas reais dos leads que levaram cobranca por engano
    for (const frase of [
      "Ok obrigado",
      "Se não for no capela",
      "Depois conversamos",
      "Quero fazer um simulado",
      "Conforme for o endereço, não me interessa",
      "Bom dia, não obrigado",
      "Tenho interesse nesse imóvel",
      "Até no valor de duzentos mil",
    ]) {
      expect(leadReclamouDeAbandono(frase), frase).toBe(false);
    }
  });

  it("pega as quatro reclamacoes reais da semana", () => {
    for (const frase of [
      "Vcs não respondem",
      "Estou mas vc não fala nada",
      "A gente fala sim, vocês respondem não. Pelo amor de Deus, gente.",
      "Bom dia tenho interesse, só que não me responde as mensagens",
    ]) {
      expect(leadReclamouDeAbandono(frase), frase).toBe(true);
    }
  });

  it("vazio nao reclama", () => {
    expect(leadReclamouDeAbandono("")).toBe(false);
    expect(leadReclamouDeAbandono(null)).toBe(false);
  });
});
