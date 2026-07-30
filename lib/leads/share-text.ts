/**
 * Monta o "resumo do atendimento" que a atendente copia pra colar num e-mail
 * (gestor, Jurídico, Financeiro…). Pedido do Darlei em 30/07.
 *
 * Por que renderizar a partir de `pipeline.settings.fields` em vez de listar os
 * campos aqui: a declaração do pipeline é editável em Configurações → Opções dos
 * campos e já tem rótulo, tipo, ordem, seção e visibilidade condicional. Campo
 * novo no pipeline entra no resumo sozinho, sem tocar neste arquivo — chumbar a
 * lista aqui garantiria resumo desatualizado em algumas semanas.
 *
 * As **observações internas** (`lead.description`) entram no fim, em bloco
 * próprio e preservando as quebras de linha (30/07: o Darlei pediu depois de ver
 * o resumo sem elas). ⚠️ É texto livre da atendente saindo do sistema por
 * e-mail: o `esc()` cuida do HTML, mas o julgamento do conteúdo é humano.
 *
 * O que NÃO entra: histórico de mensagens do WhatsApp e link do card. Se um dia
 * entrarem, é acrescentar bloco aqui — o `subject` já existe pensando no envio
 * por e-mail direto do CRM (hoje não há RESEND_API_KEY em produção).
 *
 * Função PURA: recebe tudo por parâmetro (inclusive `now`) pra ser testável.
 */
import { format, parseISO } from "date-fns";

import type { CustomFieldDef } from "@/components/contacts/CustomFieldsEditor";
import type { Lead } from "@/lib/types/leads";

export interface LeadShareInput {
  lead: Lead;
  /** Campos declarados no pipeline (readCustomFields do settings). */
  fields: CustomFieldDef[];
  /** `settings.form_hide` — campos embutidos que este pipeline não usa. */
  hiddenFormFields?: Set<string>;
  /** Nome da etapa atual (o board tem as stages em cache). */
  stageName?: string | null;
  /** Como o pipeline chama um card ("Atendimento" na Itaville). */
  leadNoun?: string;
  /** Injetável pra teste. */
  now?: Date;
}

export interface LeadShareOutput {
  /** Linha de título — serve de assunto do e-mail. */
  subject: string;
  /** Versão texto puro (WhatsApp, editor sem formatação). */
  text: string;
  /** Versão formatada (Gmail/Outlook preservam ao colar). */
  html: string;
}

interface Row {
  label: string;
  value: string;
}
interface Block {
  /** Título da seção; vazio = bloco principal, sem cabeçalho. */
  title: string;
  rows: Row[];
}

/**
 * Rótulo já terminado em pontuação não ganha ":" — senão sai
 * "Titular no exterior?: Sim".
 */
function labelSep(label: string): string {
  return /[?:!]$/.test(label) ? "" : ":";
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Data ISO (yyyy-mm-dd ou timestamp) → dd/MM/yyyy. Valor estranho volta cru. */
function fmtDate(raw: string): string {
  try {
    const d = parseISO(raw);
    if (Number.isNaN(d.getTime())) return raw;
    return format(d, "dd/MM/yyyy");
  } catch {
    return raw;
  }
}

/** Rótulo da opção escolhida (select/multiselect guardam o `value`). */
function optionLabel(f: CustomFieldDef, value: string, values: Record<string, unknown>): string {
  const fromStatic = f.options?.find((o) => o.value === value)?.label;
  if (fromStatic) return fromStatic;
  if (f.optionsBy) {
    const parent = String(values[f.optionsBy.field] ?? "");
    const fromDep = (f.optionsBy.map[parent] ?? []).find((o) => o.value === value)?.label;
    if (fromDep) return fromDep;
  }
  return value;
}

function isEmpty(v: unknown): boolean {
  return (
    v === undefined ||
    v === null ||
    v === "" ||
    (Array.isArray(v) && v.length === 0) ||
    (typeof v === "string" && v.trim() === "")
  );
}

function formatValue(
  f: CustomFieldDef,
  v: unknown,
  values: Record<string, unknown>,
): string | null {
  if (isEmpty(v)) return null;
  if (typeof v === "boolean") return v ? "Sim" : "Não";
  if (Array.isArray(v)) {
    const parts = v
      .filter((x): x is string => typeof x === "string" && x.trim() !== "")
      .map((x) => optionLabel(f, x, values));
    return parts.length ? parts.join(", ") : null;
  }
  if (typeof v === "number") return String(v);
  if (typeof v !== "string") return null;

  const s = v.trim();
  if (f.type === "date") return fmtDate(s);
  if (f.type === "select") return optionLabel(f, s, values);
  // textarea: uma linha só, pro resumo não virar parede de texto no e-mail.
  if (f.type === "textarea") return s.replace(/\s*\n+\s*/g, " · ");
  return s;
}

/** Campo condicional (showWhen) só entra quando o campo-pai casa — igual ao form. */
function isVisible(f: CustomFieldDef, values: Record<string, unknown>): boolean {
  if (!f.showWhen) return true;
  return f.showWhen.in.includes(String(values[f.showWhen.field] ?? ""));
}

function formatBRL(cents: number, currency: string | null): string {
  try {
    return new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: currency ?? "BRL",
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency ?? "BRL"}`;
  }
}

export function buildLeadShareText(input: LeadShareInput): LeadShareOutput {
  const { lead, fields, hiddenFormFields, stageName, leadNoun = "Atendimento" } = input;
  const now = input.now ?? new Date();
  const values = (lead.custom_fields ?? {}) as Record<string, unknown>;
  const hidden = hiddenFormFields ?? new Set<string>();

  const contactName =
    lead.contact?.display_name?.trim() || lead.contact?.name?.trim() || null;

  // Cabeçalho: os campos EMBUTIDOS do card (não vêm de settings.fields).
  const head: Row[] = [];
  if (lead.external_id) head.push({ label: "Nº do chamado", value: lead.external_id });
  head.push({ label: "Assunto", value: lead.title });
  if (contactName) head.push({ label: "Cliente", value: contactName });
  if (lead.contact?.phone_number) {
    head.push({ label: "Telefone", value: lead.contact.phone_number });
  }
  if (stageName) head.push({ label: "Etapa", value: stageName });
  head.push({ label: "Aberto em", value: fmtDate(lead.created_at) });
  if (lead.value_cents != null && !hidden.has("value")) {
    head.push({ label: "Valor", value: formatBRL(lead.value_cents, lead.currency) });
  }
  if (lead.expected_close_date && !hidden.has("expected_close_date")) {
    head.push({ label: "Previsão de fechamento", value: fmtDate(lead.expected_close_date) });
  }

  // Campos do pipeline, na ordem declarada, agrupando por `section` (campos sem
  // seção caem no bloco principal, junto do cabeçalho).
  const blocks: Block[] = [{ title: "", rows: head }];
  for (const f of fields) {
    if (!isVisible(f, values)) continue;
    const value = formatValue(f, values[f.key], values);
    if (value === null) continue;
    const title = f.section ?? "";
    const last = blocks[blocks.length - 1]!;
    if (last.title === title) last.rows.push({ label: f.label, value });
    else blocks.push({ title, rows: [{ label: f.label, value }] });
  }

  const subject = lead.external_id
    ? `${leadNoun} ${lead.external_id}${contactName ? ` — ${contactName}` : ""}`
    : `${leadNoun} — ${lead.title}`;
  const footer = `Resumo gerado pelo CRM em ${format(now, "dd/MM/yyyy 'às' HH:mm")}.`;

  // Observações internas: bloco solto no fim, com as quebras de linha do que foi
  // digitado (é relato corrido, não par rótulo/valor). Normaliza CRLF e corta
  // sequência de linhas vazias, senão o e-mail sai com buracos.
  const notes = (lead.description ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const NOTES_TITLE = "Observações internas";

  const textParts: string[] = [subject, ""];
  for (const b of blocks) {
    if (b.rows.length === 0) continue;
    if (b.title) textParts.push(`— ${b.title} —`);
    for (const r of b.rows) textParts.push(`${r.label}${labelSep(r.label)} ${r.value}`);
    textParts.push("");
  }
  if (notes) textParts.push(`— ${NOTES_TITLE} —`, notes, "");
  textParts.push(footer);

  const htmlParts: string[] = [
    `<p style="margin:0 0 12px;font-weight:600">${esc(subject)}</p>`,
  ];
  for (const b of blocks) {
    if (b.rows.length === 0) continue;
    if (b.title) {
      htmlParts.push(
        `<p style="margin:16px 0 4px;font-weight:600">${esc(b.title)}</p>`,
      );
    }
    htmlParts.push('<table cellpadding="0" cellspacing="0" style="border-collapse:collapse">');
    for (const r of b.rows) {
      htmlParts.push(
        `<tr><td style="padding:2px 12px 2px 0;vertical-align:top;white-space:nowrap"><strong>${esc(r.label + labelSep(r.label))}</strong></td>` +
          `<td style="padding:2px 0;vertical-align:top">${esc(r.value)}</td></tr>`,
      );
    }
    htmlParts.push("</table>");
  }
  if (notes) {
    htmlParts.push(
      `<p style="margin:16px 0 4px;font-weight:600">${esc(NOTES_TITLE)}</p>`,
      // pre-wrap preserva as quebras de linha ao colar no Gmail/Outlook.
      `<p style="margin:0;white-space:pre-wrap">${esc(notes)}</p>`,
    );
  }
  htmlParts.push(
    `<p style="margin:16px 0 0;font-size:12px;color:#666">${esc(footer)}</p>`,
  );

  return { subject, text: textParts.join("\n"), html: htmlParts.join("") };
}
