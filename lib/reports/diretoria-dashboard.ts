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
  contact_id: string | null;
  status: "open" | "won" | "lost";
  created_at: string;
  closed_at: string | null;
  custom_fields: Record<string, unknown> | null;
  stage: { name: string | null } | { name: string | null }[] | null;
}

/** Linha de mensagem (mínima) p/ o tempo de 1ª resposta humana. */
export interface FirstResponseMsgRow {
  conversation_id: string | null;
  direction: string | null;
  sent_by_user_id: string | null;
  sent_at: string | null;
  created_at: string;
}

interface Slice {
  label: string;
  value: number;
}

export interface FirstResponse {
  avgMinutes: number | null;
  label: string;
  amostra: number;
}

export interface Crise {
  distrato: number;
  juridico: number;
  multa: number;
  so_previsao: number;
  exterior: number;
  via_terceiro: number;
  reincidentes: number;
  semaforo: { verde: number; amarelo: number; vermelho: number };
  total: number;
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
  crise: Crise;
  primeiraResposta: FirstResponse;
}

// Regras da crise — batem 1:1 com lib/reports/posvenda.ts (mesma taxonomia do seed).
const SUBS_JURIDICO = new Set([
  "ameaça de ação judicial",
  "advogado constituído",
  "notificação",
  "disputa contratual",
  "Procon",
]);
const SUBS_MULTA = new Set(["multa por atraso", "cálculo de multa/devolução"]);
const RELACAO_TERCEIRO = new Set(["Representante", "Parente", "Advogado"]);

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

function formatDuration(minutes: number): string {
  if (minutes < 1) return "menos de 1 min";
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m > 0 ? `${h}h ${m}min` : `${h}h`;
}

/**
 * Tempo médio de PRIMEIRA RESPOSTA HUMANA por conversa: do 1º inbound do cliente
 * até o 1º outbound enviado por um usuário (sent_by_user_id não-nulo = humano; o
 * bot manda sem user). Média em minutos sobre conversas que tiveram resposta.
 * PURA (sem I/O) — a rota busca as mensagens e passa aqui.
 */
export function computeFirstResponse(msgs: FirstResponseMsgRow[]): FirstResponse {
  const firstIn = new Map<string, number>();
  const firstHuman = new Map<string, number>();
  for (const m of msgs) {
    if (!m.conversation_id) continue;
    const ts = Date.parse(m.sent_at ?? m.created_at);
    if (!Number.isFinite(ts)) continue;
    if (m.direction === "inbound") {
      const cur = firstIn.get(m.conversation_id);
      if (cur === undefined || ts < cur) firstIn.set(m.conversation_id, ts);
    } else if (m.direction === "outbound" && m.sent_by_user_id) {
      const cur = firstHuman.get(m.conversation_id);
      if (cur === undefined || ts < cur) firstHuman.set(m.conversation_id, ts);
    }
  }
  const deltas: number[] = [];
  for (const [conv, inTs] of firstIn) {
    const outTs = firstHuman.get(conv);
    if (outTs !== undefined && outTs > inTs) deltas.push((outTs - inTs) / 60_000);
  }
  if (deltas.length === 0) return { avgMinutes: null, label: "—", amostra: 0 };
  const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  return { avgMinutes: avg, label: formatDuration(avg), amostra: deltas.length };
}

/** `now` é injetado (não `new Date()` interno) — mantém a função pura/testável. */
export function computeDiretoriaDashboard(
  rows: DiretoriaLeadRow[],
  now: Date,
  firstResponse: FirstResponse,
): DiretoriaDashboard {
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

  // Termômetro da crise (mesma lógica do painel interno).
  let distrato = 0;
  let juridico = 0;
  let multa = 0;
  let so_previsao = 0;
  let exterior = 0;
  let via_terceiro = 0;
  let verde = 0;
  let amarelo = 0;
  let vermelho = 0;
  const chamadosPorContato = new Map<string, number>();

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

    // Termômetro da crise
    const cat = field(cf, "categoria");
    const sub = field(cf, "subcategoria");
    const nivel = field(cf, "nivel_acompanhamento");
    const relacao = field(cf, "interlocutor_relacao");
    if (cat === "Distrato e rescisão" || sub === "intenção de distrato") distrato++;
    if (cat === "Jurídico" || SUBS_JURIDICO.has(sub) || relacao === "Advogado") juridico++;
    if (SUBS_MULTA.has(sub)) multa++;
    if (sub === "nova previsão de entrega") so_previsao++;
    if (field(cf, "titular_exterior") === "Sim") exterior++;
    if (RELACAO_TERCEIRO.has(relacao)) via_terceiro++;
    if (nivel === "Verde") verde++;
    else if (nivel === "Amarelo") amarelo++;
    else if (nivel === "Vermelho") vermelho++;
    if (row.contact_id) {
      chamadosPorContato.set(row.contact_id, (chamadosPorContato.get(row.contact_id) ?? 0) + 1);
    }

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
  let reincidentes = 0;
  for (const n of chamadosPorContato.values()) if (n >= 2) reincidentes++;

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
    crise: {
      distrato,
      juridico,
      multa,
      so_previsao,
      exterior,
      via_terceiro,
      reincidentes,
      semaforo: { verde, amarelo, vermelho },
      total,
    },
    primeiraResposta: firstResponse,
  };
}
