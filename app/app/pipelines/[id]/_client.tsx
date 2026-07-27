"use client";
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useBoard } from "@/hooks/kanban/useBoard";
import { takeNewLeadHandoff, type NewLeadHandoff } from "@/lib/kanban/new-lead-handoff";

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const obj = err as { message?: unknown; code?: unknown; details?: unknown; hint?: unknown };
    if (typeof obj.message === "string") {
      const code = typeof obj.code === "string" ? ` [${obj.code}]` : "";
      return `${obj.message}${code}`;
    }
    try {
      return JSON.stringify(err);
    } catch {
      return "Erro desconhecido";
    }
  }
  return String(err);
}
import { KanbanBoard } from "@/components/kanban/KanbanBoard";
import { FilterBar } from "@/components/kanban/FilterBar";
import { BulkActionBar } from "@/components/kanban/BulkActionBar";
import { NewLeadDialog } from "@/components/kanban/NewLeadDialog";
import { EditLeadDialog } from "@/components/kanban/EditLeadDialog";
import { readCustomFields, readHiddenFormFields } from "@/components/contacts/CustomFieldsEditor";
import { Button } from "@/components/ui/button";
import { Plus } from "@/lib/ui/icons";
import type { LeadFilters } from "@/lib/kanban/filters";
import { applyFilters } from "@/lib/kanban/filters";

export function PipelinePageClient({
  pipelineId,
  initialName,
}: {
  pipelineId: string;
  initialName: string;
}) {
  const { data, isLoading, error } = useBoard(pipelineId);
  const router = useRouter();
  const searchParams = useSearchParams();
  const [filters, setFilters] = useState<LeadFilters>({ status: "all" });
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [newOpen, setNewOpen] = useState(false);

  const filteredLeads = data ? applyFilters(data.leads, filters) : [];
  const leadNoun = data?.pipeline.vocabulary?.lead ?? "Lead";

  // Abertura direta de um atendimento existente via ?open=<leadId> (reincidente).
  // O board já tem campos/etapas em cache, então o EditLeadDialog abre pronto.
  const openId = searchParams.get("open");
  const openLead = openId && data ? (data.leads.find((l) => l.id === openId) ?? null) : null;

  // "Abrir atendimento" (lista de Contatos / Inbox) manda pra cá com ?novo=1 e
  // deixa contato + pré-preenchimento no sessionStorage: abre a tela de Novo
  // Atendimento (com a busca de comprador) em vez de criar o card por baixo.
  const wantsNew = searchParams.get("novo") === "1";
  const [handoff, setHandoff] = useState<NewLeadHandoff | null>(null);
  useEffect(() => {
    if (!wantsNew) return;
    setHandoff(takeNewLeadHandoff() ?? {});
    setNewOpen(true);
  }, [wantsNew]);

  function closeNewDialog(v: boolean) {
    setNewOpen(v);
    if (v) return;
    // Solta a semente (a próxima abertura manual não pode herdar o contato).
    setHandoff(null);
    if (wantsNew) router.replace(`/app/pipelines/${pipelineId}`);
  }

  return (
    <div className="flex h-full flex-col gap-4">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">
          {data?.pipeline.name ?? initialName}
        </h1>
        <Button onClick={() => setNewOpen(true)} disabled={!data}>
          <Plus size={16} className="mr-2" /> Novo {leadNoun}
        </Button>
      </header>
      {data && (
        <NewLeadDialog
          // Remonta ao receber a semente: o formulário lê os valores iniciais
          // na montagem, e sem o remount ele abriria vazio (ou com o contato
          // de uma abertura anterior).
          key={handoff?.contact?.id ?? (handoff ? "handoff" : "manual")}
          open={newOpen}
          onOpenChange={closeNewDialog}
          pipelineId={pipelineId}
          stages={data.stages}
          fields={readCustomFields(data.pipeline.settings)}
          leadNoun={leadNoun}
          hiddenFields={readHiddenFormFields(data.pipeline.settings)}
          initialContact={handoff?.contact ?? null}
          initialTitle={handoff?.title ?? ""}
          initialDescription={handoff?.description ?? null}
          initialCustomFields={handoff?.custom_fields}
        />
      )}
      <FilterBar filters={filters} onChange={setFilters} leads={data?.leads ?? []} />
      {error ? (
        <div className="border-destructive/30 bg-destructive/10 rounded-md border p-4 text-sm">
          Erro ao carregar pipeline: {formatError(error)}
        </div>
      ) : isLoading || !data ? (
        <div className="flex flex-1 animate-pulse items-center justify-center text-muted-foreground">
          Carregando…
        </div>
      ) : (
        <KanbanBoard
          pipelineId={pipelineId}
          stages={data.stages}
          leads={filteredLeads}
          pipeline={data.pipeline}
          selectedIds={selectedIds}
          onSelectionChange={setSelectedIds}
        />
      )}
      <BulkActionBar
        selectedIds={selectedIds}
        stages={data?.stages ?? []}
        pipelineId={pipelineId}
        onClear={() => setSelectedIds([])}
      />
      {openLead && (
        <EditLeadDialog
          open
          onOpenChange={(v) => {
            if (!v) router.replace(`/app/pipelines/${pipelineId}`);
          }}
          lead={openLead}
          pipelineId={pipelineId}
        />
      )}
    </div>
  );
}
