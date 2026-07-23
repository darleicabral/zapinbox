import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";
import { readCustomFields } from "@/components/contacts/CustomFieldsEditor";
import { FieldOptionsClient } from "./_client";

export const dynamic = "force-dynamic";

/**
 * /app/settings/campos — editor amigável das OPÇÕES dos campos de seleção do
 * pipeline (Categoria, Subcategoria, Canal, Responsável, etc.), sem precisar
 * mexer em JSON nem re-rodar o seed. Grava em crm_pipelines.settings.fields via
 * a server action updatePipelineConfig (que preserva optionsBy/showWhen/section).
 * Admin-only. Usa o pipeline default da org ativa.
 */
export default async function FieldOptionsPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (!user.is_platform_admin && ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    redirect("/403");
  }

  const supabase = await createClient();
  const { data: pipeline } = await supabase
    .from("crm_pipelines")
    .select("id, name, settings")
    .eq("organization_id", activeOrg.orgId)
    .eq("is_default", true)
    .eq("is_archived", false)
    .order("position")
    .limit(1)
    .maybeSingle<{ id: string; name: string; settings: Record<string, unknown> | null }>();

  if (!pipeline) redirect("/app/settings");

  const fields = readCustomFields(pipeline.settings);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Opções dos campos</h1>
        <p className="text-sm text-muted-foreground">
          Cadastre as opções que aparecem nos menus do atendimento — {pipeline.name}.
        </p>
      </header>
      <FieldOptionsClient pipelineId={pipeline.id} initialFields={fields} />
    </div>
  );
}
