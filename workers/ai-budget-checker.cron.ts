/**
 * AI budget checker cron (EPIC-06 wave 11, S-06.11).
 *
 * Scans `ai_budgets`, computes consumed%, and:
 *   - emits `ai.budget_warning` event + sends email to org admins when pct
 *     crosses `alarm_threshold_pct` (rate-limited: once per 24h via
 *     `last_alarm_sent_at`).
 *   - flips `is_throttled` (or `is_disabled` per `action_at_100pct`) and
 *     emits `ai.budget_throttled` once consumption hits 100%.
 *
 * Driver: scheduled cron route (Vercel Cron / external scheduler) calling
 * `runBudgetChecker()`. Idempotent: rerunning within the 24h window does NOT
 * re-emit warnings.
 *
 * Anti-pattern guard: NEVER calls Postgres triggers for HTTP — alarms are
 * emitted from this TS worker, never from `fn_update_budget_consumption`.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email/resend";
import { buildBudgetAlarmEmail } from "@/lib/email/templates/ai-budget-alarm";

interface BudgetRow {
  organization_id: string;
  monthly_limit_cents: number;
  current_month_consumed_cents: number;
  alarm_threshold_pct: number;
  action_at_100pct: string;
  is_throttled: boolean;
  is_disabled: boolean;
  last_alarm_sent_at: string | null;
}

export interface BudgetCheckerStats {
  scanned: number;
  warnings_emitted: number;
  throttled: number;
}

const ALARM_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function pctOf(consumed: number, limit: number): number {
  if (!limit || limit <= 0) return 0;
  return Math.round((consumed * 10000) / limit) / 100;
}

function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
}

async function fetchOrgName(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
): Promise<string | null> {
  const { data } = await admin
    .from("organizations")
    .select("display_name")
    .eq("id", orgId)
    .maybeSingle();
  return (data?.display_name as string | undefined) ?? null;
}

async function fetchAdminEmails(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
): Promise<string[]> {
  const { data: rows, error } = await admin
    .from("user_organizations")
    .select("user_id")
    .eq("organization_id", orgId)
    .eq("role", "admin")
    .is("revoked_at", null);
  if (error || !rows || rows.length === 0) return [];

  const emails: string[] = [];
  for (const r of rows) {
    const userId = (r as { user_id: string }).user_id;
    try {
      const { data: u } = await admin.auth.admin.getUserById(userId);
      const email = u?.user?.email;
      if (email) emails.push(email);
    } catch (err) {
      console.warn("[ai-budget] getUserById failed", {
        orgId,
        userId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return emails;
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

export async function runBudgetChecker(): Promise<BudgetCheckerStats> {
  const admin = createAdminClient();
  const stats: BudgetCheckerStats = {
    scanned: 0,
    warnings_emitted: 0,
    throttled: 0,
  };

  const { data: rows, error } = await admin
    .from("ai_budgets")
    .select(
      "organization_id, monthly_limit_cents, current_month_consumed_cents, alarm_threshold_pct, action_at_100pct, is_throttled, is_disabled, last_alarm_sent_at",
    )
    .gt("monthly_limit_cents", 0);

  if (error) {
    console.warn("[ai-budget] scan query failed", { error: error.message });
    return stats;
  }

  const budgets = (rows ?? []) as BudgetRow[];
  stats.scanned = budgets.length;
  const now = Date.now();

  for (const b of budgets) {
    const pct = pctOf(b.current_month_consumed_cents, b.monthly_limit_cents);

    // ---- Warning (>= alarm_threshold_pct, cooldown 24h) ------------------
    const lastAlarmMs = b.last_alarm_sent_at
      ? new Date(b.last_alarm_sent_at).getTime()
      : 0;
    const cooledDown = !lastAlarmMs || now - lastAlarmMs >= ALARM_COOLDOWN_MS;

    if (pct >= b.alarm_threshold_pct && cooledDown) {
      await emitEvent(admin, "ai.budget_warning", b.organization_id, {
        pct,
        consumed_cents: b.current_month_consumed_cents,
        limit_cents: b.monthly_limit_cents,
      });

      const { error: updErr } = await admin
        .from("ai_budgets")
        .update({ last_alarm_sent_at: new Date().toISOString() })
        .eq("organization_id", b.organization_id);
      if (updErr) {
        console.warn("[ai-budget] failed to stamp last_alarm_sent_at", {
          orgId: b.organization_id,
          error: updErr.message,
        });
      }

      // Email admins (fire-and-forget).
      try {
        const [orgName, emails] = await Promise.all([
          fetchOrgName(admin, b.organization_id),
          fetchAdminEmails(admin, b.organization_id),
        ]);
        if (emails.length > 0) {
          const tpl = buildBudgetAlarmEmail({
            pct,
            consumedCents: b.current_month_consumed_cents,
            limitCents: b.monthly_limit_cents,
            orgName,
            dashboardUrl: `${appUrl()}/app/ai/usage`,
          });
          await sendEmail({
            to: emails,
            subject: tpl.subject,
            html: tpl.html,
            text: tpl.text,
            tags: [
              { name: "kind", value: "ai-budget-alarm" },
              { name: "org", value: b.organization_id },
            ],
          });
        }
      } catch (err) {
        console.warn("[ai-budget] alarm email dispatch failed", {
          orgId: b.organization_id,
          err: err instanceof Error ? err.message : String(err),
        });
      }

      stats.warnings_emitted += 1;
    }

    // ---- Throttle / disable at 100% --------------------------------------
    if (pct >= 100 && !b.is_throttled && !b.is_disabled) {
      const action = b.action_at_100pct === "disable" ? "disable" : "throttle";
      const patch =
        action === "disable" ? { is_disabled: true } : { is_throttled: true };

      const { error: thrErr } = await admin
        .from("ai_budgets")
        .update(patch)
        .eq("organization_id", b.organization_id);
      if (thrErr) {
        console.warn("[ai-budget] failed to apply throttle", {
          orgId: b.organization_id,
          action,
          error: thrErr.message,
        });
        continue;
      }

      await emitEvent(admin, "ai.budget_throttled", b.organization_id, {
        pct,
        consumed_cents: b.current_month_consumed_cents,
        limit_cents: b.monthly_limit_cents,
        action,
      });
      stats.throttled += 1;
    }
  }

  return stats;
}
