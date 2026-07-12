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

export interface BusinessHours {
  timezone: string;
  days: number[]; // 0=domingo … 6=sábado
  start: string; // "HH:MM"
  end: string; // "HH:MM"
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

function isOnline(m: MemberRow, now: number): boolean {
  if (m.presence !== "online") return false;
  if (!m.presence_updated_at) return false;
  return now - new Date(m.presence_updated_at).getTime() <= PRESENCE_FRESH_MS;
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
 * Próximo atendente ONLINE do rodízio circular (ordem estável por user_id,
 * começando após o ponteiro). Retorna null se ninguém elegível está online
 * (decisão aprovada: fila fica sem dono). Avança o ponteiro quando escolhe.
 */
export async function pickNextAssignee(
  admin: SupabaseClient,
  organizationId: string,
  opts: { excludeUserIds?: string[]; pointer?: string | null } = {},
): Promise<string | null> {
  const members = await loadEligibleMembers(admin, organizationId);
  const now = Date.now();
  const excluded = new Set(opts.excludeUserIds ?? []);
  const candidates = members.filter((m) => !excluded.has(m.user_id) && isOnline(m, now));
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
    if (dayIdx === -1 || !cfg.days.includes(dayIdx)) return false;
    const cur = `${hour}:${minute}`;
    if (cfg.start <= cfg.end) return cur >= cfg.start && cur <= cfg.end;
    return cur >= cfg.start || cur <= cfg.end; // cruza meia-noite
  } catch {
    return true; // config inválida não pode travar o atendimento
  }
}
