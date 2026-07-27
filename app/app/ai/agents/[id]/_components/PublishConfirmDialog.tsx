"use client";
import * as React from "react";

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

import type { AgentVersionRow } from "@/hooks/ai/useAgentVersions";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draft: AgentVersionRow;
  published: AgentVersionRow | null;
  onConfirm: () => void;
  isPending: boolean;
}

function diffArr(prev: string[], next: string[]) {
  const added = next.filter((x) => !prev.includes(x));
  const removed = prev.filter((x) => !next.includes(x));
  return { added, removed };
}

export function PublishConfirmDialog({
  open,
  onOpenChange,
  draft,
  published,
  onConfirm,
  isPending,
}: Props) {
  const toolsDiff = diffArr(published?.tool_ids ?? [], draft.tool_ids);
  const promptDeltaChars = draft.system_prompt.length - (published?.system_prompt.length ?? 0);
  const modelChanged = !published || draft.model !== published.model;
  const providerChanged = !published || draft.provider !== published.provider;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>Publicar v{draft.version_number}?</AlertDialogTitle>
          <AlertDialogDescription>
            Esta versão se tornará a ativa no atendimento. A versão atual ({" "}
            {published ? `v${published.version_number}` : "nenhuma"}) será marcada como superseded.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="border-border/60 space-y-2 rounded-md border p-3 text-xs">
          {providerChanged ? (
            <p>
              <strong>Provider:</strong>{" "}
              {published ? `${published.provider} → ${draft.provider}` : draft.provider}
            </p>
          ) : null}
          {modelChanged ? (
            <p>
              <strong>Modelo:</strong>{" "}
              {published ? `${published.model} → ${draft.model}` : draft.model}
            </p>
          ) : null}
          {toolsDiff.added.length > 0 ? (
            <p>
              <strong>Tools adicionadas:</strong> {toolsDiff.added.join(", ")}
            </p>
          ) : null}
          {toolsDiff.removed.length > 0 ? (
            <p>
              <strong>Tools removidas:</strong> {toolsDiff.removed.join(", ")}
            </p>
          ) : null}
          <p>
            <strong>Prompt:</strong>{" "}
            {promptDeltaChars > 0
              ? `+${promptDeltaChars} chars`
              : promptDeltaChars < 0
                ? `${promptDeltaChars} chars`
                : "sem alteração"}
          </p>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancelar</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} disabled={isPending}>
            {isPending ? "Publicando…" : `Publicar v${draft.version_number}`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
