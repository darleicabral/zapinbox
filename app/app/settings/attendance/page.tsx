import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";
import type { AtendimentoInput, BusinessHoursInput } from "@/lib/schemas/atendimento";
import { AtendimentoForm } from "./_form";

export const dynamic = "force-dynamic";

interface AttendanceRow {
  enabled: boolean;
  claim_sla_minutes: number;
  first_response_sla_minutes: number;
  max_passes: number;
  notify_whatsapp: boolean;
  business_hours: BusinessHoursInput | null;
}

interface FollowupRow {
  enabled: boolean;
  throttle_seconds: number;
  steps: Array<{ after_minutes: number; message: string; discard?: boolean }>;
  business_hours: BusinessHoursInput | null;
}

export default async function AttendanceSettingsPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (!user.is_platform_admin && ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }

  const supabase = await createClient();
  const [{ data: att }, { data: fu }] = await Promise.all([
    supabase
      .from("attendance_settings")
      .select(
        "enabled, claim_sla_minutes, first_response_sla_minutes, max_passes, notify_whatsapp, business_hours",
      )
      .eq("organization_id", activeOrg.orgId)
      .maybeSingle(),
    supabase
      .from("followup_settings")
      .select("enabled, throttle_seconds, steps, business_hours")
      .eq("organization_id", activeOrg.orgId)
      .maybeSingle(),
  ]);

  const attendance = (att ?? null) as AttendanceRow | null;
  const followup = (fu ?? null) as FollowupRow | null;

  // Expediente é compartilhado (mesma janela nas 2 tabelas); qualquer um serve.
  const businessHours = attendance?.business_hours ?? followup?.business_hours ?? null;

  const initial: AtendimentoInput = {
    business_hours:
      businessHours && Array.isArray(businessHours.windows)
        ? businessHours
        : null,
    attendance: {
      enabled: attendance?.enabled ?? false,
      claim_sla_minutes: attendance?.claim_sla_minutes ?? 5,
      first_response_sla_minutes: attendance?.first_response_sla_minutes ?? 10,
      max_passes: attendance?.max_passes ?? 3,
      notify_whatsapp: attendance?.notify_whatsapp ?? true,
    },
    followup: {
      enabled: followup?.enabled ?? false,
      throttle_seconds: followup?.throttle_seconds ?? 3,
      steps: Array.isArray(followup?.steps) ? followup.steps : [],
    },
  };

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Atendimento</h1>
        <p className="text-sm text-muted-foreground">
          Expediente, rodízio da equipe, prazos de resposta e reengajamento automático.
        </p>
      </header>
      <AtendimentoForm initial={initial} />
    </div>
  );
}
