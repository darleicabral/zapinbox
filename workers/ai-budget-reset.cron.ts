/**
 * AI budget reset cron (EPIC-06 wave 11, S-06.11).
 *
 * Runs once per month (or daily — idempotent thanks to the `current_period_start`
 * filter). Resets the monthly counter, lifts `is_throttled`, clears
 * `last_alarm_sent_at`. Never touches `is_disabled` — that flag requires
 * explicit admin re-enable.
 */
import { createAdminClient } from "@/lib/supabase/admin";

interface BudgetRow {
  organization_id: string;
}

export interface BudgetResetStats {
  reset_count: number;
}

function startOfUtcMonthIso(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    .toISOString()
    .slice(0, 10);
}

async function emitEvent(
  admin: ReturnType<typeof createAdminClient>,
  eventType: string,
  orgId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const { error } = await admin.rpc("emit_event" as never, {
    p_event_type: eventType,
    p_entity_kind: "organization",
    p_entity_id: orgId,
    p_organization_id: orgId,
    p_payload: payload,
  } as never);
  if (error) {
    console.warn("[ai-budget] emit_event failed", {
      eventType,
      orgId,
      error: error.message,
    });
  }
}

export async function runBudgetReset(): Promise<BudgetResetStats> {
  const admin = createAdminClient();
  const periodStart = startOfUtcMonthIso();

  // Find all budgets whose current_period_start is older than this month.
  const { data: rows, error } = await admin
    .from("ai_budgets")
    .select("organization_id")
    .lt("current_period_start", periodStart);

  if (error) {
    console.warn("[ai-budget] reset scan failed", { error: error.message });
    return { reset_count: 0 };
  }

  const budgets = (rows ?? []) as BudgetRow[];
  let resetCount = 0;

  for (const b of budgets) {
    const { error: updErr } = await admin
      .from("ai_budgets")
      .update({
        current_month_consumed_cents: 0,
        current_period_start: periodStart,
        is_throttled: false,
        last_alarm_sent_at: null,
      })
      .eq("organization_id", b.organization_id)
      .lt("current_period_start", periodStart);
    if (updErr) {
      console.warn("[ai-budget] reset failed", {
        orgId: b.organization_id,
        error: updErr.message,
      });
      continue;
    }
    await emitEvent(admin, "ai.budget_reset", b.organization_id, {
      period_start: periodStart,
    });
    resetCount += 1;
  }

  return { reset_count: resetCount };
}
