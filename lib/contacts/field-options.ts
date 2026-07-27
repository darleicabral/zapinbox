/**
 * Opções dos selects do contato, lidas no SERVIDOR a partir do pipeline default
 * da org (`crm_pipelines.settings.fields`).
 *
 * Fonte única da verdade: "Empreendimento" é o MESMO campo do atendimento, então
 * o que a admin cadastra em Configurações → Opções dos campos vale nos dois
 * lugares. Org sem o campo (Avant/ZapInbox) recebe lista vazia — a coluna some.
 */
import { createClient } from "@/lib/supabase/server";

interface FieldOption {
  value?: unknown;
  label?: unknown;
}

interface PipelineField {
  key?: unknown;
  options?: unknown;
}

export interface ContactFieldOptions {
  empreendimentos: string[];
}

export async function loadContactFieldOptions(orgId: string): Promise<ContactFieldOptions> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("crm_pipelines")
    .select("settings")
    .eq("organization_id", orgId)
    .eq("is_default", true)
    .eq("is_archived", false)
    .order("position")
    .limit(1)
    .maybeSingle<{ settings: Record<string, unknown> | null }>();

  const rawFields = data?.settings?.fields;
  if (!Array.isArray(rawFields)) return { empreendimentos: [] };

  const field = (rawFields as PipelineField[]).find((f) => f?.key === "empreendimento");
  const options = Array.isArray(field?.options) ? (field.options as FieldOption[]) : [];

  const empreendimentos = options
    .map((o) =>
      typeof o?.value === "string" ? o.value : typeof o?.label === "string" ? o.label : "",
    )
    .filter((s): s is string => s.length > 0);

  return { empreendimentos };
}
