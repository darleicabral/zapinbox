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
