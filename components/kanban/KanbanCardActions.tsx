"use client";
import { useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { DotsThree, PencilSimple } from "@/lib/ui/icons";
import { useWinLead } from "@/hooks/kanban/useUpdateLead";
import { LoseLeadDialog } from "./LoseLeadDialog";
import { EditLeadDialog } from "./EditLeadDialog";
import type { Lead } from "@/lib/types/leads";
import type { BoardData } from "@/lib/kanban/types";

interface KanbanCardActionsProps {
  lead: Lead;
  pipelineId: string;
}

export function KanbanCardActions({ lead, pipelineId }: KanbanCardActionsProps) {
  const [loseOpen, setLoseOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const winMutation = useWinLead(pipelineId);
  const qc = useQueryClient();
  const vocab = qc.getQueryData<BoardData>(["board", pipelineId])?.pipeline.vocabulary;
  const wonWord = (vocab?.won ?? "ganho").toLowerCase();
  const lostWord = (vocab?.lost ?? "perdido").toLowerCase();

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 data-[state=open]:opacity-100"
            onClick={(e) => e.stopPropagation()}
            aria-label="Ações"
          >
            <DotsThree size={16} weight="bold" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          onClick={(e) => e.stopPropagation()}
        >
          <DropdownMenuItem
            onSelect={() => {
              setEditOpen(true);
            }}
          >
            <PencilSimple size={14} className="mr-2" /> Editar
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={winMutation.isPending}
            onSelect={() => {
              winMutation.mutate({ leadId: lead.id });
            }}
          >
            Marcar como {wonWord}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              setLoseOpen(true);
            }}
          >
            Marcar como {lostWord}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <LoseLeadDialog
        open={loseOpen}
        onOpenChange={setLoseOpen}
        leadId={lead.id}
        pipelineId={pipelineId}
      />
      <EditLeadDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        lead={lead}
        pipelineId={pipelineId}
      />
    </>
  );
}
