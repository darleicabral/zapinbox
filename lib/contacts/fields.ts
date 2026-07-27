/**
 * Campos custom do CONTATO — gravados em `contacts.custom_fields` (migration 0028).
 *
 * Hoje são os campos de trabalho ativo do pós-venda (Itaville): em que
 * empreendimento o cliente comprou, se já ligamos e como terminou a abordagem.
 * São dados do CONTATO (valem para sempre, entre atendimentos), por isso não
 * moram em `crm_leads.custom_fields`.
 *
 * As opções de "Empreendimento" NÃO são chumbadas aqui: vêm do mesmo campo do
 * pipeline (`crm_pipelines.settings.fields`), editável em Configurações →
 * Opções dos campos. Ver `lib/contacts/field-options.ts`.
 */

export const CONTACT_FIELD = {
  empreendimento: "empreendimento",
  liguei: "liguei",
  status: "status_contato",
} as const;

/** Status da abordagem ativa (coluna "Status" na lista de contatos). */
export const CONTACT_STATUS_OPTIONS = [
  "Passei a informação",
  "Cliente não atende",
  "Cliente em Atendimento",
  "Pediu para ligar depois",
] as const;

export type ContactCustomFields = Record<string, unknown> | null | undefined;

export function contactFieldText(cf: ContactCustomFields, key: string): string {
  const v = cf?.[key];
  return typeof v === "string" ? v : "";
}

export function contactFieldFlag(cf: ContactCustomFields, key: string): boolean {
  return cf?.[key] === true;
}

/**
 * "Liguei" guarda o INSTANTE da ligação (ISO), não um booleano: o registro de
 * quando se falou com o cliente vale mais que o "sim". Aceita o `true` das
 * marcações antigas (vira "marcado, sem horário").
 */
export function contactCallLog(cf: ContactCustomFields): { at: Date | null; marked: boolean } {
  const v = cf?.[CONTACT_FIELD.liguei];
  if (typeof v === "string" && v) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? { at: null, marked: true } : { at: d, marked: true };
  }
  return { at: null, marked: v === true };
}
