/**
 * AI budget helpers (EPIC-06 wave 11, S-06.11).
 *
 * Pure read helpers used by:
 *  - the budget enforcement guard inside `workers/ai-response-worker.ts`
 *    (already calls `ai_budgets` directly, kept untouched).
 *  - `app/api/v1/ai/budget` route handlers.
 *  - `workers/ai-budget-checker.cron.ts` for alarm/throttle decisions.
 *
 * Uses the admin client because callers run either in cron context or in
 * authenticated handlers that have already validated the organization_id from
 * a trusted source (JWT). Never derive org from request body.
 */
import { createAdminClient } from "@/lib/supabase/admin";

export interface BudgetStatus {
  organization_id: string;
  monthly_limit_cents: number;
  current_month_consumed_cents: number;
  pct: number;
  is_throttled: boolean;
  is_disabled: boolean;
  alarm_threshold_pct: number;
  action_at_100pct: "throttle" | "disable";
  current_period_start: string;
  last_alarm_sent_at: string | null;
  updated_at: string;
}

const COLUMNS =
  "organization_id, monthly_limit_cents, current_month_consumed_cents, alarm_threshold_pct, action_at_100pct, current_period_start, last_alarm_sent_at, is_throttled, is_disabled, updated_at";

const DEFAULTS = {
  monthly_limit_cents: 0,
  current_month_consumed_cents: 0,
  alarm_threshold_pct: 80,
  action_at_100pct: "throttle" as const,
  is_throttled: false,
  is_disabled: false,
};

function pctOf(consumed: number, limit: number): number {
  if (!limit || limit <= 0) return 0;
  return Math.round((consumed * 10000) / limit) / 100;
}

function normalizeAction(v: string | null | undefined): "throttle" | "disable" {
  return v === "disable" ? "disable" : "throttle";
}

/** Returns true when the bot should pause for the org (handoff stays alive). */
export async function isBudgetExhausted(orgId: string): Promise<boolean> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("ai_budgets")
    .select("is_throttled, is_disabled")
    .eq("organization_id", orgId)
    .maybeSingle();
  if (!data) return false;
  return Boolean(data.is_throttled) || Boolean(data.is_disabled);
}

/** Full budget snapshot for UI / API. Falls back to safe defaults. */
export async function getBudgetStatus(orgId: string): Promise<BudgetStatus> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("ai_budgets")
    .select(COLUMNS)
    .eq("organization_id", orgId)
    .maybeSingle();

  if (!data) {
    const today = new Date();
    const periodStart = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1),
    )
      .toISOString()
      .slice(0, 10);
    return {
      organization_id: orgId,
      monthly_limit_cents: DEFAULTS.monthly_limit_cents,
      current_month_consumed_cents: DEFAULTS.current_month_consumed_cents,
      pct: 0,
      is_throttled: DEFAULTS.is_throttled,
      is_disabled: DEFAULTS.is_disabled,
      alarm_threshold_pct: DEFAULTS.alarm_threshold_pct,
      action_at_100pct: DEFAULTS.action_at_100pct,
      current_period_start: periodStart,
      last_alarm_sent_at: null,
      updated_at: new Date().toISOString(),
    };
  }

  const monthlyLimit = Number(data.monthly_limit_cents ?? 0);
  const consumed = Number(data.current_month_consumed_cents ?? 0);

  return {
    organization_id: data.organization_id,
    monthly_limit_cents: monthlyLimit,
    current_month_consumed_cents: consumed,
    pct: pctOf(consumed, monthlyLimit),
    is_throttled: Boolean(data.is_throttled),
    is_disabled: Boolean(data.is_disabled),
    alarm_threshold_pct: Number(data.alarm_threshold_pct ?? DEFAULTS.alarm_threshold_pct),
    action_at_100pct: normalizeAction(data.action_at_100pct as string | null),
    current_period_start: String(data.current_period_start),
    last_alarm_sent_at: (data.last_alarm_sent_at as string | null) ?? null,
    updated_at: String(data.updated_at),
  };
}
