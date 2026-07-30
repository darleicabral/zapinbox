/**
 * Testes de buildLeadShareText (lib/leads/share-text.ts) — o resumo do card que
 * a atendente cola num e-mail pro gestor/Jurídico/Financeiro.
 *
 * O que importa garantir aqui: nada de campo vazio poluindo o e-mail, rótulo de
 * opção em vez do valor cru, campo condicional respeitado (bloco Van Gogh só
 * quando o empreendimento é Van Gogh) e escape de HTML — o título do chamado é
 * texto digitado pela atendente e vai pra dentro do HTML colado no e-mail.
 */
import { describe, it, expect } from "vitest";

import { buildLeadShareText } from "@/lib/leads/share-text";
import type { CustomFieldDef } from "@/components/contacts/CustomFieldsEditor";
import type { Lead } from "@/lib/types/leads";

const NOW = new Date("2026-07-30T14:05:00.000Z");

function lead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: "l1",
    organization_id: "org1",
    pipeline_id: "p1",
    stage_id: "s1",
    contact_id: "c1",
    title: "Boleto de julho",
    description: "anotação interna que NÃO deve sair",
    status: "open",
    lost_reason: null,
    position_in_stage: 1,
    value_cents: null,
    currency: null,
    owner_user_id: null,
    assigned_at: null,
    last_activity_at: null,
    expected_close_date: null,
    closed_at: null,
    source: "manual",
    source_metadata: {},
    external_id: "VG-2026-001",
    custom_fields: {},
    tags: [],
    created_at: "2026-07-21T12:00:00.000Z",
    updated_at: "2026-07-21T12:00:00.000Z",
    created_by_user_id: null,
    contact: { display_name: "Maria Silva", name: "Maria", phone_number: "+5531999990000" },
    ...overrides,
  };
}

const FIELDS: CustomFieldDef[] = [
  { key: "interlocutor", label: "Interlocutor (quem falou)", type: "text" },
  {
    key: "titular_exterior",
    label: "Titular no exterior?",
    type: "select",
    options: [
      { value: "Sim", label: "Sim" },
      { value: "Não", label: "Não" },
    ],
  },
  {
    key: "empreendimento",
    label: "Empreendimento",
    type: "select",
    options: [
      { value: "Van Gogh", label: "Van Gogh" },
      { value: "Jardim Canaã", label: "Jardim Canaã" },
    ],
  },
  {
    key: "categoria",
    label: "Categoria",
    type: "select",
    options: [{ value: "Financeiro", label: "Financeiro" }],
  },
  {
    key: "subcategoria",
    label: "Subcategoria",
    type: "select",
    optionsBy: {
      field: "categoria",
      map: { Financeiro: [{ value: "boleto", label: "2ª via de boleto" }] },
    },
  },
  { key: "proximo_contato", label: "Próximo contato", type: "date" },
  { key: "unidades_cliente", label: "Unidades adquiridas", type: "number" },
  {
    key: "vg_impacto_previsao",
    label: "Impacto da nova previsão",
    type: "select",
    options: [{ value: "Relevante", label: "Relevante" }],
    showWhen: { field: "empreendimento", in: ["Van Gogh"] },
    section: "Acompanhamento Van Gogh",
  },
];

function build(l: Lead) {
  return buildLeadShareText({
    lead: l,
    fields: FIELDS,
    hiddenFormFields: new Set(["value", "expected_close_date"]),
    stageName: "Em análise",
    leadNoun: "Atendimento",
    now: NOW,
  });
}

describe("buildLeadShareText", () => {
  it("abre com nº do chamado, cliente e etapa", () => {
    const out = build(lead({ custom_fields: { interlocutor: "Maria" } }));
    expect(out.subject).toBe("Atendimento VG-2026-001 — Maria Silva");
    expect(out.text).toContain("Nº do chamado: VG-2026-001");
    expect(out.text).toContain("Cliente: Maria Silva");
    expect(out.text).toContain("Telefone: +5531999990000");
    expect(out.text).toContain("Etapa: Em análise");
    expect(out.text).toContain("Aberto em: 21/07/2026");
  });

  it("não inclui campo vazio nem as observações internas", () => {
    const out = build(lead({ custom_fields: { interlocutor: "Maria", categoria: "" } }));
    expect(out.text).toContain("Interlocutor (quem falou): Maria");
    expect(out.text).not.toContain("Categoria");
    expect(out.text).not.toContain("Subcategoria");
    expect(out.text).not.toContain("anotação interna");
  });

  it("não duplica pontuação em rótulo que já termina com ?", () => {
    const out = build(lead({ custom_fields: { titular_exterior: "Sim" } }));
    expect(out.text).toContain("Titular no exterior? Sim");
    expect(out.text).not.toContain("Titular no exterior?:");
    expect(out.html).not.toContain("exterior?:");
  });

  it("usa o rótulo da opção, inclusive nas dependentes", () => {
    const out = build(lead({ custom_fields: { categoria: "Financeiro", subcategoria: "boleto" } }));
    expect(out.text).toContain("Subcategoria: 2ª via de boleto");
  });

  it("esconde o bloco Van Gogh quando o empreendimento é outro", () => {
    const fora = build(
      lead({ custom_fields: { empreendimento: "Jardim Canaã", vg_impacto_previsao: "Relevante" } }),
    );
    expect(fora.text).not.toContain("Acompanhamento Van Gogh");
    expect(fora.text).not.toContain("Impacto da nova previsão");

    const dentro = build(
      lead({ custom_fields: { empreendimento: "Van Gogh", vg_impacto_previsao: "Relevante" } }),
    );
    expect(dentro.text).toContain("— Acompanhamento Van Gogh —");
    expect(dentro.text).toContain("Impacto da nova previsão: Relevante");
  });

  it("formata data, número e valor escondido pelo pipeline", () => {
    const out = build(
      lead({
        custom_fields: { proximo_contato: "2026-08-03", unidades_cliente: 2 },
        value_cents: 12_345_600,
      }),
    );
    expect(out.text).toContain("Próximo contato: 03/08/2026");
    expect(out.text).toContain("Unidades adquiridas: 2");
    expect(out.text).not.toContain("Valor:"); // form_hide = ["value"]
  });

  it("escapa HTML do que a atendente digitou", () => {
    const out = build(lead({ title: 'Reclamação <b>"grave"</b> & urgente' }));
    expect(out.html).toContain("Reclamação &lt;b&gt;&quot;grave&quot;&lt;/b&gt; &amp; urgente");
    expect(out.html).not.toContain("<b>");
    // texto puro mantém o que foi digitado
    expect(out.text).toContain('Reclamação <b>"grave"</b> & urgente');
  });

  it("marca a hora da extração e sobrevive a card sem nº e sem contato", () => {
    const out = build(lead({ external_id: null, contact: null }));
    expect(out.subject).toBe("Atendimento — Boleto de julho");
    expect(out.text).not.toContain("Cliente:");
    expect(out.text).toContain("Resumo gerado pelo CRM em 30/07/2026 às");
  });
});
