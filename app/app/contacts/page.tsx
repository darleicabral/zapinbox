import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { loadContactFieldOptions } from "@/lib/contacts/field-options";
import { ContactsListClient } from "./_client";

export const dynamic = "force-dynamic";

export default async function ContactsPage() {
  // As opções de "Empreendimento" vêm do pipeline default (mesma fonte do
  // atendimento) — carregadas aqui pra não precisar de rota nova só pra isso.
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  const { empreendimentos } = activeOrg
    ? await loadContactFieldOptions(activeOrg.orgId)
    : { empreendimentos: [] };

  return <ContactsListClient empreendimentos={empreendimentos} />;
}
