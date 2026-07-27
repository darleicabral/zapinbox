/**
 * Parser de CSV → contatos (importação em lote na tela de Contatos).
 *
 * Módulo PURO (sem I/O, sem React): recebe o texto do arquivo e devolve linhas
 * normalizadas + diagnóstico. Assim dá pra testar (tests/unit/contacts-csv.test.ts)
 * e usar tanto no browser (preview) quanto no servidor.
 *
 * Tolerante ao que sai de planilha brasileira de verdade:
 *  - separador `;` (padrão pt-BR), `,` ou TAB — detectado pelo cabeçalho
 *  - BOM, CRLF, campos entre aspas com `;` dentro e aspas duplicadas ("")
 *  - cabeçalhos com acento/caixa variada ("E-mail", "TELEFONE", "Cliente")
 *  - células `=HIPERLINK("url";"Fulano")` (export do CVCRM) → fica só "Fulano"
 *  - telefone em qualquer formato → E.164 (+55… quando vier sem país)
 *  - empreendimento "VENDAS - RESIDENCIAL VAN GOGH" → casa com a opção "Van Gogh"
 */

export interface ParsedContactRow {
  /** Linha no arquivo (1 = cabeçalho), para mostrar no relatório de erros. */
  line: number;
  name: string | null;
  phone: string | null;
  email: string | null;
  empreendimento: string | null;
  /** Motivo de a linha ter sido descartada (sem nome e sem telefone). */
  skipped?: string;
}

export interface ParsedContactsFile {
  rows: ParsedContactRow[];
  /** Cabeçalhos originais do arquivo, na ordem. */
  headers: string[];
  /** Cabeçalho → campo do CRM (só os reconhecidos). */
  mapping: Record<string, ContactCsvField>;
  /** Cabeçalhos ignorados (nenhum campo do CRM correspondente). */
  ignored: string[];
}

export type ContactCsvField = "name" | "phone" | "email" | "empreendimento";

/** Aliases de cabeçalho (normalizados: minúsculo, sem acento e sem pontuação). */
const HEADER_ALIASES: Record<ContactCsvField, string[]> = {
  name: [
    "nome",
    "cliente",
    "contato",
    "nome do cliente",
    "comprador",
    "razao social",
    "nome completo",
  ],
  phone: [
    "telefone",
    "celular",
    "whatsapp",
    "fone",
    "telefone 1",
    "telefone celular",
    "contato telefone",
  ],
  email: ["email", "e mail", "e mail do cliente", "email do cliente"],
  empreendimento: ["empreendimento", "obra", "produto", "empreendimento unidade"],
};

export function normalizeHeader(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** `=HIPERLINK("http://…";"GS Logística")` → `GS Logística`. */
export function unwrapFormula(value: string): string {
  const v = value.trim();
  if (!v.startsWith("=")) return value.trim();
  const m = v.match(/^=\s*(?:HIPERLINK|HYPERLINK)\s*\((.*)\)\s*$/i);
  if (!m) return v.replace(/^=/, "").trim();
  const args = splitLine(m[1]!, ";").length > 1 ? splitLine(m[1]!, ";") : splitLine(m[1]!, ",");
  const last = args[args.length - 1] ?? "";
  return last.trim();
}

/**
 * Telefone → E.164. Assume Brasil quando vier sem código de país (10/11 dígitos).
 * Devolve null quando não dá pra discar (curto demais / vazio).
 */
export function normalizePhone(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const hadPlus = trimmed.startsWith("+");
  let digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;
  digits = digits.replace(/^0+/, "");
  // O banco exige `^\+\d{8,15}$` (contacts_phone_e164_format): o que passar
  // disso é lixo de planilha (dois números na mesma célula, ramal colado…).
  if (digits.length > 15) return null;
  if (hadPlus) return digits.length >= 8 ? `+${digits}` : null;
  if (digits.length === 10 || digits.length === 11) return `+55${digits}`;
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith("55"))
    return `+${digits}`;
  if (digits.length >= 11) return `+${digits}`; // internacional sem "+"
  return null;
}

const EMAIL_RE = /^[^\s@;,]+@[^\s@;,]+\.[^\s@;,]{2,}$/;

export function normalizeEmail(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  return EMAIL_RE.test(v) ? v : null;
}

/**
 * Casa o valor do arquivo com uma das opções cadastradas ("VENDAS - RESIDENCIAL
 * VAN GOGH" → "Van Gogh"). Sem correspondência, devolve o texto limpo.
 */
export function normalizeEmpreendimento(raw: string, options: string[]): string | null {
  const cleaned = raw
    .replace(/^\s*vendas\s*[-–]\s*/i, "")
    .replace(/^\s*residencial\s+/i, "")
    .trim();
  if (!cleaned) return null;
  const key = normalizeHeader(cleaned);
  const hit = options.find((o) => {
    const ok = normalizeHeader(o);
    return ok === key || key.includes(ok) || ok.includes(key);
  });
  return hit ?? cleaned;
}

/** Divide UMA linha respeitando aspas (`"a;b"` continua um campo só). */
function splitLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** Quebra o texto em linhas lógicas (uma célula entre aspas pode ter \n dentro). */
function splitRecords(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"') {
      quoted = !quoted;
      cur += ch;
      continue;
    }
    if (!quoted && (ch === "\n" || ch === "\r")) {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.length) out.push(cur);
  return out;
}

function detectDelimiter(headerLine: string): string {
  const candidates = [";", ",", "\t"];
  let best = ";";
  let bestCount = -1;
  for (const d of candidates) {
    const count = splitLine(headerLine, d).length;
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

export function parseContactsCsv(
  text: string,
  opts: { empreendimentos?: string[] } = {},
): ParsedContactsFile {
  // BOM (planilha salva em UTF-8 pelo Excel) entraria colado no 1º cabeçalho.
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records = splitRecords(clean).filter((l) => l.trim().length > 0);
  if (records.length === 0) {
    return { rows: [], headers: [], mapping: {}, ignored: [] };
  }

  const delimiter = detectDelimiter(records[0]!);
  const headers = splitLine(records[0]!, delimiter).map((h) => h.trim());

  const mapping: Record<string, ContactCsvField> = {};
  const ignored: string[] = [];
  const taken = new Set<ContactCsvField>();
  for (const h of headers) {
    const norm = normalizeHeader(h);
    const field = (Object.keys(HEADER_ALIASES) as ContactCsvField[]).find(
      (f) => !taken.has(f) && HEADER_ALIASES[f].includes(norm),
    );
    if (field) {
      mapping[h] = field;
      taken.add(field);
    } else if (h) {
      ignored.push(h);
    }
  }

  const rows: ParsedContactRow[] = [];
  for (let r = 1; r < records.length; r++) {
    const cells = splitLine(records[r]!, delimiter);
    const get = (field: ContactCsvField): string => {
      const idx = headers.findIndex((h) => mapping[h] === field);
      return idx >= 0 ? unwrapFormula(cells[idx] ?? "") : "";
    };

    const name = get("name").trim() || null;
    const phone = normalizePhone(get("phone"));
    const email = normalizeEmail(get("email"));
    const empreendimento = normalizeEmpreendimento(
      get("empreendimento"),
      opts.empreendimentos ?? [],
    );

    const row: ParsedContactRow = {
      line: r + 1,
      name,
      phone,
      email,
      empreendimento,
    };
    if (!name && !phone && !email) {
      row.skipped = "linha sem nome, telefone e e-mail";
    }
    rows.push(row);
  }

  return { rows, headers, mapping, ignored };
}

/**
 * Remove duplicados DENTRO do arquivo, mantendo a primeira ocorrência — a
 * planilha de vendas repete o comprador uma vez por unidade.
 *
 * Telefone E e-mail contam como identidade: o banco tem unique por org tanto em
 * `wa_identity` (derivado do telefone) quanto em `email_normalized`, então dois
 * parentes com o mesmo e-mail e telefones diferentes derrubariam o lote inteiro.
 */
export function dedupeRows(rows: ParsedContactRow[]): {
  unique: ParsedContactRow[];
  duplicates: number;
} {
  const seenPhone = new Set<string>();
  const seenEmail = new Set<string>();
  const unique: ParsedContactRow[] = [];
  let duplicates = 0;
  for (const row of rows) {
    const dupPhone = !!row.phone && seenPhone.has(row.phone);
    const dupEmail = !!row.email && seenEmail.has(row.email);
    if (dupPhone || dupEmail) {
      duplicates++;
      continue;
    }
    if (row.phone) seenPhone.add(row.phone);
    if (row.email) seenEmail.add(row.email);
    unique.push(row);
  }
  return { unique, duplicates };
}
