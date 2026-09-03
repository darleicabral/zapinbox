/**
 * C4 — Rodízio de atendimento (round-robin com ponteiro) + config de SLA.
 *
 * Config/estado por tenant em `attendance_settings` (migration 0028). O ponteiro
 * `last_assigned_user_id` torna o rodízio circular de verdade (a tool de handoff
 * sorteava com Math.random()). Presença mínima: heartbeat grava
 * `user_organizations.presence/presence_updated_at`; "online" = presence='online'
 * E heartbeat fresco (staleness — sem cron de auto-offline).
 *
 * Race note: dois handoffs simultâneos podem ler o mesmo ponteiro e escolher o
 * mesmo atendente. Aceitável (pior caso: 2 conversas pro mesmo corretor); o
 * UPDATE do ponteiro é last-write-wins.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export const PRESENCE_FRESH_MS = 3 * 60_000;

export interface AttendanceSettings {
  organization_id: string;
  enabled: boolean;
  claim_sla_minutes: number;
  first_response_sla_minutes: number;
  max_passes: number;
  business_hours: BusinessHours | null;
  last_assigned_user_id: string | null;
}

export interface BusinessWindow {
  days: number[]; // 0=domingo … 6=sábado
  start: string; // "HH:MM"
  end: string; // "HH:MM"
}

export interface BusinessHours {
  timezone: string;
  // Forma legada: janela única (days/start/end na raiz).
  days?: number[];
  start?: string;
  end?: string;
  // Forma nova: janelas por grupo de dias (ex.: seg-sex 09-18 + sáb 09-12).
  windows?: BusinessWindow[];
}

interface MemberRow {
  user_id: string;
  role: string;
  presence: string | null;
  presence_updated_at: string | null;
}

export async function loadAttendanceSettings(
  admin: SupabaseClient,
  organizationId: string,
): Promise<AttendanceSettings | null> {
  const { data } = await admin
    .from("attendance_settings")
    .select(
      "organization_id, enabled, claim_sla_minutes, first_response_sla_minutes, max_passes, business_hours, last_assigned_user_id",
    )
    .eq("organization_id", organizationId)
    .maybeSingle();
  return (data as AttendanceSettings | null) ?? null;
}

async function loadEligibleMembers(
  admin: SupabaseClient,
  organizationId: string,
): Promise<MemberRow[]> {
  const { data } = await admin
    .from("user_organizations")
    .select("user_id, role, presence, presence_updated_at")
    .eq("organization_id", organizationId)
    .is("revoked_at", null)
    .in("role", ["agent", "manager", "admin"])
    .order("user_id", { ascending: true });
  return (data ?? []) as MemberRow[];
}

/**
 * Próximo atendente do rodízio circular (ordem estável por user_id, começando
 * após o ponteiro). Avança o ponteiro quando escolhe.
 *
 * ⚠️ Decisão do Darlei (02/09/2026): distribui pra TODOS os corretores elegíveis,
 * ONLINE OU NÃO. Antes só escolhia quem estava online (presença fresca), e por
 * isso corretor com o CRM fechado nunca era escolhido e nunca recebia o aviso no
 * WhatsApp. O corretor é mobile-first e vive no zap, então quem está na vez do
 * rodízio deve ser avisado mesmo offline. Custo aceito: a conversa pode cair pra
 * quem não vai atender agora e ficar parada até ele ver — o SLA (sla.ts) reescala
 * pro próximo e, no teto de passes, pro gestor. Retorna null só se NÃO houver
 * nenhum corretor elegível na org (fora os já excluídos).
 */
export async function pickNextAssignee(
  admin: SupabaseClient,
  organizationId: string,
  opts: { excludeUserIds?: string[]; pointer?: string | null } = {},
): Promise<string | null> {
  const members = await loadEligibleMembers(admin, organizationId);
  const excluded = new Set(opts.excludeUserIds ?? []);
  // ⚠️ Decisão do Darlei (03/09/2026): o DONO não entra no rodízio. Ele é admin e
  // só supervisiona, não atende lead. Antes ele era sorteado como qualquer um, e
  // o bot chegou a prometer ao cliente "vou te encaminhar pro Dono, nosso
  // corretor" (o nome no cadastro é literalmente "Dono").
  // Gerente CONTINUA no rodízio: na Avant o Cleber é manager e atende.
  // O admin segue recebendo a escalada do SLA por pickFallbackManager, que é o
  // papel dele — supervisionar quando ninguém assume, não estar na fila.
  const candidates = members.filter((m) => !excluded.has(m.user_id) && m.role !== "admin");
  if (candidates.length === 0) return null;

  let pointer = opts.pointer;
  if (pointer === undefined) {
    const settings = await loadAttendanceSettings(admin, organizationId);
    pointer = settings?.last_assigned_user_id ?? null;
  }

  // Circular: primeiro candidato com user_id > ponteiro; sem nenhum, volta ao início.
  const next =
    (pointer ? candidates.find((m) => m.user_id > pointer!) : undefined) ?? candidates[0]!;

  await admin
    .from("attendance_settings")
    .update({ last_assigned_user_id: next.user_id })
    .eq("organization_id", organizationId);

  return next.user_id;
}

/**
 * Fallback após max_passes: gestor (manager; senão admin) do tenant,
 * independente de presença — alguém precisa ficar como dono com alerta.
 */
export async function pickFallbackManager(
  admin: SupabaseClient,
  organizationId: string,
): Promise<string | null> {
  const members = await loadEligibleMembers(admin, organizationId);
  const manager = members.find((m) => m.role === "manager") ?? members.find((m) => m.role === "admin");
  return manager?.user_id ?? null;
}

function inWindow(w: BusinessWindow, dayIdx: number, cur: string): boolean {
  if (!w.days.includes(dayIdx)) return false;
  if (w.start <= w.end) return cur >= w.start && cur <= w.end;
  return cur >= w.start || cur <= w.end; // cruza meia-noite
}

/** Mesma semântica do inBusinessHours dos triggers de agente (janela pode cruzar meia-noite). */
export function inBusinessHours(cfg: BusinessHours | null, at: Date): boolean {
  if (!cfg) return true;
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: cfg.timezone,
      hour12: false,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
    const parts = fmt.formatToParts(at);
    const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
    const hour = parts.find((p) => p.type === "hour")?.value ?? "00";
    const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
    const dayIdx = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday);
    if (dayIdx === -1) return false;
    const cur = `${hour}:${minute}`;

    // Forma nova: qualquer janela vale (ex.: seg-sex 09-18 + sáb 09-12).
    if (Array.isArray(cfg.windows) && cfg.windows.length > 0) {
      return cfg.windows.some((w) => inWindow(w, dayIdx, cur));
    }
    // Forma legada: janela única na raiz.
    if (Array.isArray(cfg.days) && cfg.start && cfg.end) {
      return inWindow({ days: cfg.days, start: cfg.start, end: cfg.end }, dayIdx, cur);
    }
    return true; // config sem janelas não restringe
  } catch {
    return true; // config inválida não pode travar o atendimento
  }
}
