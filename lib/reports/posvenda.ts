/**
 * Agregação do painel de pós-venda / crise (tenant Itaville).
 *
 * Função PURA sobre as linhas de `crm_leads` (custom_fields + stage) — sem I/O,
 * fácil de testar. As strings de opção batem 1:1 com o `settings.fields` semeado
 * pelo `scripts/seed-itaville.ts` (Categoria, Subcategoria, Nível, etc.).
 *
 * A rota (`/api/v1/reports/posvenda`) busca as linhas escopadas por org (RLS) e
 * chama `computePosvendaReport`. Volume esperado no MVP é baixo (a operação começa
 * do zero); se um dia passar de alguns milhares, migrar a agregação para SQL.
 */

export interface ReportLeadRow {
  id: string;
  contact_id: string | null;
  created_at: string;
  custom_fields: Record<string, unknown> | null;
  /** Embed to-one de crm_stages (pode vir como objeto ou array, dependendo do driver). */
  stage: StageEmbed | StageEmbed[] | null;
}

interface StageEmbed {
  name: string | null;
  is_won: boolean | null;
  is_lost: boolean | null;
}

export interface Bucket {
  label: string;
  count: number;
}

export interface PosvendaReport {
  total: number;
  abertos: number;
  concluidos: number;
  cancelados: number;
  /** Métricas da crise (§4.1 da spec). */
  distrato: number;
  juridico: number;
  multa: number;
  so_previsao: number;
  exterior: number;
  via_terceiro: number;
  reincidentes: number;
  semaforo: { verde: number; amarelo: number; vermelho: number };
  /** Relatórios "grátis do dado" (§4-A). */
  por_empreendimento: Bucket[];
  por_categoria: Bucket[];
  por_canal: Bucket[];
  /** Impacto Van Gogh (§4-C, relatório 11). */
  vg_impacto: Bucket[];
  /** Curva da onda: chamados do Van Gogh por dia (ordem crescente de data). */
  onda_vangogh: Array<{ date: string; count: number }>;
}

const SUBS_JURIDICO = new Set([
  "ameaça de ação judicial",
  "advogado constituído",
  "notificação",
  "disputa contratual",
  "Procon",
]);
const SUBS_MULTA = new Set(["multa por atraso", "cálculo de multa/devolução"]);
const RELACAO_TERCEIRO = new Set(["Representante", "Parente", "Advogado"]);

function stageOf(row: ReportLeadRow): StageEmbed | null {
  const s = row.stage;
  if (!s) return null;
  return Array.isArray(s) ? (s[0] ?? null) : s;
}

/** Lê uma chave string de custom_fields (vazio se ausente/não-string). */
function field(cf: Record<string, unknown>, key: string): string {
  const v = cf[key];
  return typeof v === "string" ? v : "";
}

/** Incrementa um contador num mapa. */
function bump(map: Map<string, number>, key: string): void {
  if (!key) return;
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** Converte o mapa em buckets ordenados por contagem desc. */
function toBuckets(map: Map<string, number>): Bucket[] {
  return [...map.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);
}

export function computePosvendaReport(rows: ReportLeadRow[]): PosvendaReport {
  let abertos = 0;
  let concluidos = 0;
  let cancelados = 0;
  let distrato = 0;
  let juridico = 0;
  let multa = 0;
  let so_previsao = 0;
  let exterior = 0;
  let via_terceiro = 0;
  let verde = 0;
  let amarelo = 0;
  let vermelho = 0;

  const empreendimento = new Map<string, number>();
  const categoria = new Map<string, number>();
  const canal = new Map<string, number>();
  const vgImpacto = new Map<string, number>();
  const ondaMap = new Map<string, number>();
  const chamadosPorContato = new Map<string, number>();

  for (const row of rows) {
    const cf = (row.custom_fields ?? {}) as Record<string, unknown>;
    const cat = field(cf, "categoria");
    const sub = field(cf, "subcategoria");
    const nivel = field(cf, "nivel_acompanhamento");
    const relacao = field(cf, "interlocutor_relacao");
    const emp = field(cf, "empreendimento");

    // Status pelo stage
    const st = stageOf(row);
    if (st?.is_won) concluidos++;
    else if (st?.is_lost) cancelados++;
    else abertos++;

    // Crise
    if (cat === "Distrato e rescisão" || sub === "intenção de distrato") distrato++;
    if (cat === "Jurídico" || SUBS_JURIDICO.has(sub) || relacao === "Advogado") juridico++;
    if (SUBS_MULTA.has(sub)) multa++;
    if (sub === "nova previsão de entrega") so_previsao++;
    if (field(cf, "titular_exterior") === "Sim") exterior++;
    if (RELACAO_TERCEIRO.has(relacao)) via_terceiro++;

    // Semáforo
    if (nivel === "Verde") verde++;
    else if (nivel === "Amarelo") amarelo++;
    else if (nivel === "Vermelho") vermelho++;

    // Breakdowns
    bump(empreendimento, emp);
    bump(categoria, cat);
    bump(canal, field(cf, "canal"));

    // Reincidência (por contato)
    if (row.contact_id) {
      chamadosPorContato.set(row.contact_id, (chamadosPorContato.get(row.contact_id) ?? 0) + 1);
    }

    // Van Gogh
    if (emp === "Van Gogh") {
      bump(vgImpacto, field(cf, "vg_tipo_impacto"));
      const day = row.created_at.slice(0, 10); // YYYY-MM-DD
      if (day) ondaMap.set(day, (ondaMap.get(day) ?? 0) + 1);
    }
  }

  let reincidentes = 0;
  for (const n of chamadosPorContato.values()) if (n >= 2) reincidentes++;

  const onda = [...ondaMap.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    total: rows.length,
    abertos,
    concluidos,
    cancelados,
    distrato,
    juridico,
    multa,
    so_previsao,
    exterior,
    via_terceiro,
    reincidentes,
    semaforo: { verde, amarelo, vermelho },
    por_empreendimento: toBuckets(empreendimento),
    por_categoria: toBuckets(categoria),
    por_canal: toBuckets(canal),
    vg_impacto: toBuckets(vgImpacto),
    onda_vangogh: onda,
  };
}
