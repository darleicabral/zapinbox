"use client";
import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useBoard } from "@/hooks/kanban/useBoard";

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

  // Abertura direta de um atendimento via ?open=<leadId> (vindo do Inbox, botão
  // "Abrir atendimento"): o board já tem os campos/etapas em cache, então o
  // EditLeadDialog abre com a triagem pré-preenchida. Fechar limpa o parâmetro.
  const openId = searchParams.get("open");
  const openLead = openId && data ? (data.leads.find((l) => l.id === openId) ?? null) : null;

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
          open={newOpen}
          onOpenChange={setNewOpen}
          pipelineId={pipelineId}
          stages={data.stages}
          fields={readCustomFields(data.pipeline.settings)}
          leadNoun={leadNoun}
          hiddenFields={readHiddenFormFields(data.pipeline.settings)}
        />
      )}
      <FilterBar filters={filters} onChange={setFilters} leads={data?.leads ?? []} />
      {error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm">
          Erro ao carregar pipeline:{" "}
          {formatError(error)}
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
