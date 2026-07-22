import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { posvendaManualDocId } from "@/lib/modules";
import { Button } from "@/components/ui/button";
import { ArrowRight } from "@/lib/ui/icons";

export const dynamic = "force-dynamic";

/**
 * /app/manual — embeda o manual de atendimento (Google Doc) do tenant como
 * página de consulta rápida para o operador (ex.: Samilis, pós-venda Itaville).
 *
 * Usa a URL /preview do Google Docs (a única que o Google permite dentro de
 * iframe; a /edit manda X-Frame-Options e não embeda). O doc precisa estar
 * compartilhado como "qualquer pessoa com o link pode ver" para renderizar sem
 * pedir login. Gateado pelo módulo pós-venda (só orgs com manual configurado).
 */
export default async function ManualPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");

  const docId = posvendaManualDocId(activeOrg.orgId);
  if (!docId) redirect("/app"); // módulo/manual não habilitado p/ esta org

  const embedUrl = `https://docs.google.com/document/d/${docId}/preview`;
  const openUrl = `https://docs.google.com/document/d/${docId}/edit`;

  return (
    <div className="flex h-full flex-col gap-4">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Manual de atendimento</h1>
          <p className="text-sm text-muted-foreground">
            Guia de consulta para o atendimento de chamados de pós-venda.
          </p>
        </div>
        <Button asChild variant="secondary" size="sm">
          <a href={openUrl} target="_blank" rel="noreferrer">
            Abrir no Google Docs
            <ArrowRight size={14} aria-hidden />
          </a>
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden rounded-lg border bg-white">
        <iframe
          src={embedUrl}
          title="Manual de atendimento"
          className="h-full w-full border-0"
          loading="lazy"
        />
      </div>
    </div>
  );
}
