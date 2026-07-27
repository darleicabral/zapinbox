"use client";
import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { DotsThree, PencilSimple, Copy, Pause, Play, Archive } from "@/lib/ui/icons";
import { deriveAgentStatus } from "./AgentStatusBadge";
import type { AgentRow } from "@/hooks/ai/useAgent";
import {
  archiveAgentAction,
  duplicateAgentAction,
  pauseAgentAction,
  unpauseAgentAction,
} from "../_actions";
import { RenameAgentDialog } from "./RenameAgentDialog";

interface Props {
  agent: AgentRow;
  /** Admin: duplicar, renomear, arquivar. */
  canWrite?: boolean;
  /** Gerente pra cima: ligar/pausar o bot (operação, não configuração). */
  canOperate?: boolean;
}

export function AgentRowMenu({ agent, canWrite = true, canOperate = true }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [renameOpen, setRenameOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);

  const status = deriveAgentStatus(agent);
  const isPaused = status === "paused" || status === "draft";
  const isArchived = status === "archived";

  const run = (
    label: string,
    action: () => Promise<{ ok: boolean; error?: string; message?: string }>,
  ) => {
    startTransition(async () => {
      try {
        const res = await action();
        if (res.ok) {
          toast.success(label);
          router.refresh();
        } else {
          toast.error(res.message ?? `Falha: ${res.error ?? "unknown"}`);
        }
      } catch {
        toast.error("Erro ao executar ação.");
      }
    });
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Menu de ações"
            disabled={isPending}
            className="size-8"
          >
            <DotsThree size={18} aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem asChild>
            <Link href={`/app/ai/agents/${agent.id}`} className="flex items-center gap-2">
              <PencilSimple size={14} aria-hidden /> {canWrite ? "Editar" : "Visualizar"}
            </Link>
          </DropdownMenuItem>
          {canWrite && (
            <>
              <DropdownMenuItem
                disabled={isArchived}
                onSelect={() => run("Agent duplicado.", () => duplicateAgentAction(agent.id))}
              >
                <Copy size={14} aria-hidden className="mr-2" /> Duplicar
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={isArchived}
                onSelect={(e) => {
                  e.preventDefault();
                  setRenameOpen(true);
                }}
              >
                <PencilSimple size={14} aria-hidden className="mr-2" /> Renomear
              </DropdownMenuItem>
            </>
          )}
          {canOperate &&
            (isPaused ? (
              <DropdownMenuItem
                disabled={isArchived || agent.kind === "mcp_agent"}
                onSelect={() => run("Agent reativado.", () => unpauseAgentAction(agent.id))}
              >
                <Play size={14} aria-hidden className="mr-2" /> Despausar
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem
                disabled={isArchived}
                onSelect={() => run("Agent pausado.", () => pauseAgentAction(agent.id))}
              >
                <Pause size={14} aria-hidden className="mr-2" /> Pausar
              </DropdownMenuItem>
            ))}
          {canWrite && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={isArchived}
                onSelect={(e) => {
                  e.preventDefault();
                  setArchiveOpen(true);
                }}
                className="text-destructive focus:text-destructive"
              >
                <Archive size={14} aria-hidden className="mr-2" /> Arquivar
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <RenameAgentDialog agent={agent} open={renameOpen} onOpenChange={setRenameOpen} />

      <AlertDialog open={archiveOpen} onOpenChange={setArchiveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Arquivar &ldquo;{agent.name}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              O agent deixa de responder gatilhos e some das listas ativas. Versões publicadas são
              preservadas para auditoria. Não é possível desarquivar pela UI nesta versão.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => run("Agent arquivado.", () => archiveAgentAction(agent.id))}
            >
              Arquivar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
