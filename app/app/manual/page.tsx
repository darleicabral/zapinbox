import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { posvendaManualDocId, posvendaPlaybookUrl } from "@/lib/modules";
import { ManualsViewer } from "./_viewer";

export const dynamic = "force-dynamic";

/**
 * /app/manual — "Manuais": página de consulta com abas.
 *  - Manual do sistema: playbook de como operar o CRM (HTML próprio embedado).
 *  - Manual de atendimento: roteiro de relacionamento (Google Doc via /preview,
 *    a única URL que o Google permite em iframe; o doc precisa estar como
 *    "qualquer pessoa com o link pode ver").
 * Gateado pelo módulo pós-venda (só orgs com pelo menos um manual configurado).
 */
export default async function ManualPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");

  const docId = posvendaManualDocId(activeOrg.orgId);
  const playbookUrl = posvendaPlaybookUrl(activeOrg.orgId);
  if (!docId && !playbookUrl) redirect("/app"); // nada configurado p/ esta org

  const tabs = [];
  if (playbookUrl) {
    tabs.push({
      key: "sistema",
      label: "Manual do sistema",
      embedUrl: playbookUrl,
      openUrl: playbookUrl,
      openLabel: "Abrir em nova aba",
    });
  }
  if (docId) {
    tabs.push({
      key: "atendimento",
      label: "Manual de atendimento",
      embedUrl: `https://docs.google.com/document/d/${docId}/preview`,
      openUrl: `https://docs.google.com/document/d/${docId}/edit`,
      openLabel: "Abrir no Google Docs",
    });
  }

  return <ManualsViewer tabs={tabs} />;
}
