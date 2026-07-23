/**
 * Agregados do Dashboard da Diretoria (Itaville) — página estática pública,
 * hospedada FORA do CRM (cPanel/subdomínio da Itaville), consumida via
 * GET /api/v1/public/itaville-dashboard (token, sem PII).
 *
 * Função PURA (mesma disciplina do lib/reports/posvenda.ts): sem I/O, fácil de
 * testar. Strings de custom_fields batem 1:1 com scripts/seed-itaville.ts;
 * ordem/cores das etapas batem com o STAGES de lá e com StageColumn no Kanban.
 */

export interface DiretoriaLeadRow {
  status: "open" | "won" | "lost";
  created_at: string;
  closed_at: string | null;
  custom_fields: Record<string, unknown> | null;
  stage: { name: string | null } | { name: string | null }[] | null;
}

interface Slice {
  label: string;
  value: number;
}

export interface DiretoriaDashboard {
  updatedAt: string;
  kpis: Array<{ label: string; value: string; foot: string; tile: string; chip: string }>;
  status: Array<Slice & { color: string }>;
  nivel: Array<Slice & { color: string }>;
  empreendimento: Slice[];
  categoria: Slice[];
  responsavel: Slice[];
  canal: Slice[];
  resolucaoPct: number;
  agenda: Slice[];
  trend: Array<{ mes: string; abertos: number; resolvidos: number }>;
}

const STAGE_ORDER: Array<{ label: string; color: string }> = [
  { label: "Novo", color: "#3B82F6" },
  { label: "Em atendimento", color: "#F59E0B" },
  { label: "Pendência", color: "#A855F7" },
  { label: "Em espera", color: "#64748B" },
  { label: "Resolvido", color: "#22C55E" },
  { label: "Cancelado", color: "#EF4444" },
];
const NIVEL_ORDER: Array<{ label: string; color: string }> = [
  { label: "Verde", color: "#2FA36B" },
  { label: "Amarelo", color: "#F5A623" },
  { label: "Vermelho", color: "#D6453D" },
];
const MES_PT = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];

function stageName(row: DiretoriaLeadRow): string {
  const s = row.stage;
  const one = Array.isArray(s) ? s[0] : s;
  return one?.name ?? "";
}
function field(cf: Record<string, unknown> | null, key: string): string {
  const v = cf?.[key];
  return typeof v === "string" ? v : "";
}
function bump(map: Map<string, number>, key: string): void {
  if (!key) return;
  map.set(key, (map.get(key) ?? 0) + 1);
}
function toSlices(map: Map<string, number>): Slice[] {
  return [...map.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
}
function daysBetween(a: string, b: string): number {
  return Math.max(0, (new Date(b).getTime() - new Date(a).getTime()) / 86_400_000);
}
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** `now` é injetado (não `new Date()` interno) — mantém a função pura/testável. */
export function computeDiretoriaDashboard(rows: DiretoriaLeadRow[], now: Date): DiretoriaDashboard {
  const today = ymd(now);
  const weekAheadStr = ymd(new Date(now.getTime() + 7 * 86_400_000));
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const stageMap = new Map<string, number>();
  const nivelMap = new Map<string, number>();
  const empMap = new Map<string, number>();
  const catMap = new Map<string, number>();
  const respMap = new Map<string, number>();
  const canalMap = new Map<string, number>();

  let abertos = 0;
  let resolvidosTotal = 0;
  let novaSemana = 0;
  let resolvidosMes = 0;
  let resolvidosMesSomaDias = 0;
  let resolvidosSemana = 0;
  let atrasados = 0;
  let hoje = 0;
  let estaSemana = 0;
  let emRisco = 0;

  const trendMap = new Map<string, { abertos: number; resolvidos: number }>();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    trendMap.set(`${d.getFullYear()}-${d.getMonth()}`, { abertos: 0, resolvidos: 0 });
  }

  for (const row of rows) {
    const cf = row.custom_fields ?? {};
    bump(stageMap, stageName(row));
    bump(nivelMap, field(cf, "nivel_acompanhamento"));
    bump(empMap, field(cf, "empreendimento"));
    bump(catMap, field(cf, "categoria"));
    bump(respMap, field(cf, "responsavel_area"));
    bump(canalMap, field(cf, "canal"));

    if (row.status === "open") {
      abertos++;
      if (field(cf, "nivel_acompanhamento") === "Vermelho") emRisco++;
      const prox = field(cf, "proximo_contato");
      if (prox) {
        if (prox < today) atrasados++;
        else if (prox === today) hoje++;
        else if (prox <= weekAheadStr) estaSemana++;
      }
    } else if (row.status === "won") {
      resolvidosTotal++;
      if (row.closed_at) {
        const closedDate = new Date(row.closed_at);
        if (closedDate >= monthStart) {
          resolvidosMes++;
          resolvidosMesSomaDias += daysBetween(row.created_at, row.closed_at);
        }
        if (closedDate >= weekAgo) resolvidosSemana++;
      }
    }

    const created = new Date(row.created_at);
    if (created >= weekAgo) novaSemana++;
    const bucket = trendMap.get(`${created.getFullYear()}-${created.getMonth()}`);
    if (bucket) bucket.abertos++;
    if (row.status === "won" && row.closed_at) {
      const closed = new Date(row.closed_at);
      const cbucket = trendMap.get(`${closed.getFullYear()}-${closed.getMonth()}`);
      if (cbucket) cbucket.resolvidos++;
    }
  }

  const total = rows.length;
  const mediaDias = resolvidosMes > 0 ? resolvidosMesSomaDias / resolvidosMes : 0;

  const trend = [...trendMap.entries()].map(([key, v]) => {
    const monthIdx = Number(key.split("-")[1]);
    return { mes: MES_PT[monthIdx] ?? "", abertos: v.abertos, resolvidos: v.resolvidos };
  });

  return {
    updatedAt: now.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" }),
    kpis: [
      {
        label: "Atendimentos abertos",
        value: String(abertos),
        foot: "em atendimento agora",
        tile: "t1",
        chip: `+${novaSemana} na semana`,
      },
      {
        label: "Resolvidos no mês",
        value: String(resolvidosMes),
        foot: `média ${mediaDias.toFixed(1)} dias p/ resolver`,
        tile: "t2",
        chip: `${resolvidosSemana} esta semana`,
      },
      {
        label: "Contatos atrasados",
        value: String(atrasados),
        foot: "deveria ser 0",
        tile: "t3",
        chip: "agenda",
      },
      {
        label: "Atendimentos em risco",
        value: String(emRisco),
        foot: "nível vermelho",
        tile: "t4",
        chip: "prioridade",
      },
    ],
    status: STAGE_ORDER.map((s) => ({ ...s, value: stageMap.get(s.label) ?? 0 })),
    nivel: NIVEL_ORDER.map((n) => ({ ...n, value: nivelMap.get(n.label) ?? 0 })),
    empreendimento: toSlices(empMap),
    categoria: toSlices(catMap),
    responsavel: toSlices(respMap),
    canal: toSlices(canalMap),
    resolucaoPct: total > 0 ? Math.round((resolvidosTotal / total) * 100) : 0,
    agenda: [
      { label: "Hoje", value: hoje },
      { label: "Atrasados", value: atrasados },
      { label: "Esta semana", value: estaSemana },
    ],
    trend,
  };
}
