"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit";
import { atendimentoSchema, type AtendimentoInput } from "@/lib/schemas/atendimento";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";

export type UpdateAtendimentoResult =
  | { ok: true }
  | { ok: false; error: string; details?: unknown };

/**
 * Salva as configurações de atendimento do tenant: expediente (aplicado ao
 * rodízio/SLA E ao follow-up — mesma janela), rodízio/SLA e cadência de
 * follow-up. Upsert: os workers tratam linha ausente como "desligado", então
 * criar aqui na primeira edição é seguro.
 */
export async function updateAtendimento(
  input: AtendimentoInput,
): Promise<UpdateAtendimentoResult> {
  const parsed = atendimentoSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "validation_failed", details: parsed.error.flatten() };
  }

  const authUser = await loadAuthUser();
  if (!authUser) return { ok: false, error: "unauthenticated" };
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) return { ok: false, error: "forbidden_tenant" };
  if (!authUser.is_platform_admin && ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    return { ok: false, error: "forbidden_role" };
  }

  const bh =
    parsed.data.business_hours && parsed.data.business_hours.windows.length > 0
      ? parsed.data.business_hours
      : null;
  // Follow-up dispara em ordem crescente de inatividade — persiste já ordenado.
  const steps = [...parsed.data.followup.steps].sort(
    (a, b) => a.after_minutes - b.after_minutes,
  );

  const supabase = await createClient();

  const { error: attErr } = await supabase.from("attendance_settings").upsert(
    {
      organization_id: activeOrg.orgId,
      enabled: parsed.data.attendance.enabled,
      claim_sla_minutes: parsed.data.attendance.claim_sla_minutes,
      first_response_sla_minutes: parsed.data.attendance.first_response_sla_minutes,
      max_passes: parsed.data.attendance.max_passes,
      notify_whatsapp: parsed.data.attendance.notify_whatsapp,
      business_hours: bh,
    },
    { onConflict: "organization_id" },
  );
  if (attErr) return { ok: false, error: attErr.message };

  const { error: fuErr } = await supabase.from("followup_settings").upsert(
    {
      organization_id: activeOrg.orgId,
      enabled: parsed.data.followup.enabled,
      throttle_seconds: parsed.data.followup.throttle_seconds,
      steps,
      business_hours: bh,
    },
    { onConflict: "organization_id" },
  );
  if (fuErr) return { ok: false, error: fuErr.message };

  const hdrs = await headers();
  await audit({
    action: "attendance_settings.updated",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "attendance_settings",
    resourceId: activeOrg.orgId,
    requestId: hdrs.get("x-request-id"),
    ip: hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: hdrs.get("user-agent") ?? null,
    metadata: {
      attendance_enabled: parsed.data.attendance.enabled,
      followup_enabled: parsed.data.followup.enabled,
      followup_steps: steps.length,
      business_hours_windows: bh?.windows.length ?? 0,
    },
  });

  revalidatePath("/app/settings/attendance");
  return { ok: true };
}
