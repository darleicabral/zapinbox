import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { hasPosvendaModule } from "@/lib/modules";
import { createClient } from "@/lib/supabase/server";
import { AgendaClient } from "@/components/agenda/AgendaClient";

export const dynamic = "force-dynamic";

/**
 * /app/agenda — agenda de próximos contatos do pós-venda. Lista os chamados
 * abertos que têm o campo "Próximo contato" (custom_fields.proximo_contato)
 * agendado, agrupados por dia (Atrasados / Hoje / Amanhã / …), para o operador
 * saber as tarefas do dia. Gateado pelo módulo pós-venda (só orgs com o fluxo).
 *
 * O pipeline usado é o default da org ativa (o "Chamados Pós-venda" da Itaville).
 */
export default async function AgendaPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (!hasPosvendaModule(activeOrg.orgId)) redirect("/app");

  const supabase = await createClient();
  const { data: pipeline } = await supabase
    .from("crm_pipelines")
    .select("id")
    .eq("is_default", true)
    .eq("is_archived", false)
    .order("position")
    .limit(1)
    .maybeSingle<{ id: string }>();

  if (!pipeline) redirect("/app/kanban");

  return <AgendaClient pipelineId={pipeline.id} />;
}
