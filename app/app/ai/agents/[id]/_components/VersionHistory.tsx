"use client";
/**
 * VersionHistory — timeline de versions com diff e revert (S-13.12).
 *
 * Cada linha: badge status + número + timestamps + ações:
 *   - "Diff": abre dialog comparando essa version contra a "outra ponta"
 *     (se essa for published → compara com latest draft; senão compara com
 *      published vigente. Fallback: a anterior na lista).
 *   - "Reverter": admin only, exclui draft da própria linha. Cria nova
 *     version-published clonada.
 */
import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
import { revertToVersionAction } from "../_actions";
import { VersionDiff } from "./VersionDiff";

interface Props {
  agentId: string;
  versions: AgentVersionRow[];
  readOnly?: boolean;
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  draft: "secondary",
  published: "default",
  superseded: "outline",
  archived: "destructive",
};

function pickCounterpart(
  versions: AgentVersionRow[],
  target: AgentVersionRow,
): AgentVersionRow | null {
  if (target.status === "published") {
    const latestDraft = versions
      .filter((v) => v.status === "draft")
      .sort((a, b) => b.version_number - a.version_number)[0];
    if (latestDraft) return latestDraft;
  }
  const published = versions.find((v) => v.status === "published");
  if (published && published.id !== target.id) return published;
  // Fallback: a versão imediatamente anterior na lista cronológica.
  const sorted = [...versions].sort((a, b) => b.version_number - a.version_number);
  const idx = sorted.findIndex((v) => v.id === target.id);
  if (idx >= 0 && idx + 1 < sorted.length) return sorted[idx + 1] ?? null;
  return null;
}

export function VersionHistory({ agentId, versions, readOnly }: Props) {
  const router = useRouter();
  const [diffOpen, setDiffOpen] = React.useState(false);
  const [diffPair, setDiffPair] = React.useState<{
    a: AgentVersionRow;
    b: AgentVersionRow;
  } | null>(null);

  const [revertTarget, setRevertTarget] = React.useState<AgentVersionRow | null>(null);
  const [reverting, setReverting] = React.useState(false);

  const sorted = React.useMemo(
    () => [...versions].sort((a, b) => b.version_number - a.version_number),
    [versions],
  );

  if (sorted.length === 0) {
    return <p className="text-sm text-muted-foreground">Nenhuma versão criada ainda.</p>;
  }

  function openDiff(target: AgentVersionRow) {
    const counterpart = pickCounterpart(sorted, target);
    if (!counterpart) {
      toast.info("Não há outra versão para comparar.");
      return;
    }
    // a = mais antiga, b = mais nova
    const [a, b] =
      target.version_number < counterpart.version_number
        ? [target, counterpart]
        : [counterpart, target];
    setDiffPair({ a, b });
    setDiffOpen(true);
  }

  async function handleRevert() {
    if (!revertTarget) return;
    setReverting(true);
    const targetNum = revertTarget.version_number;
    try {
      const res = await revertToVersionAction(agentId, revertTarget.id);
      if (!res.ok) {
        toast.error(res.message ?? `Erro: ${res.error}`);
        return;
      }
      toast.success(
        `Revertido para versão equivalente a v${targetNum} (publicada como v${res.data!.new_version_number}).`,
      );
      setRevertTarget(null);
      router.refresh();
    } finally {
      setReverting(false);
    }
  }

  return (
    <>
      <ol className="flex flex-col gap-2">
        {sorted.map((v) => {
          const canRevert = !readOnly && v.status !== "draft" && v.status !== "archived";
          return (
            <li
              key={v.id}
              className="border-border/60 flex flex-wrap items-center gap-3 rounded-md border p-3 text-sm"
            >
              <Badge variant={STATUS_VARIANT[v.status] ?? "outline"} className="text-xs">
                {v.status}
              </Badge>
              <span className="font-mono">v{v.version_number}</span>
              <span className="text-xs text-muted-foreground">
                {new Date(v.created_at).toLocaleString()}
              </span>
              <span className="font-mono text-xs text-muted-foreground">
                {v.provider}/{v.model}
              </span>
              {v.published_at ? (
                <span className="text-xs text-muted-foreground">
                  publicada em {new Date(v.published_at).toLocaleString()}
                </span>
              ) : null}
              <div className="ml-auto flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => openDiff(v)}>
                  Diff
                </Button>
                {canRevert ? (
                  <Button variant="outline" size="sm" onClick={() => setRevertTarget(v)}>
                    Reverter
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>

      <Dialog open={diffOpen} onOpenChange={setDiffOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              {diffPair
                ? `Diff v${diffPair.a.version_number} ↔ v${diffPair.b.version_number}`
                : "Diff"}
            </DialogTitle>
          </DialogHeader>
          {diffPair ? <VersionDiff versionA={diffPair.a} versionB={diffPair.b} /> : null}
        </DialogContent>
      </Dialog>

      <AlertDialog open={revertTarget != null} onOpenChange={(o) => !o && setRevertTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reverter para v{revertTarget?.version_number}?</AlertDialogTitle>
            <AlertDialogDescription>
              Uma nova versão idêntica a v{revertTarget?.version_number} será criada e publicada
              imediatamente. A versão atualmente publicada vira superseded.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={reverting}>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={handleRevert} disabled={reverting}>
              {reverting ? "Revertendo…" : "Confirmar revert"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
