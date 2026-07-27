"use client";
/**
 * RunTrace — render passo-a-passo dos `tool_calls` de um run (S-13.12).
 *
 * Estrutura esperada (definida pelo runtime da S-13.08 e pelo stub do
 * endpoint `:test`): array de
 *   { step, tool_name, args, result, started_at, ended_at, latency_ms?, error? }.
 *
 * Renderização tolerante: campos faltando viram "—". Cada step é um
 * `<details>` nativo (acessível, keyboard-friendly) com JSON pretty.
 */
import * as React from "react";

import { Badge } from "@/components/ui/badge";

interface ToolCallStep {
  step?: number;
  tool_name?: string;
  args?: unknown;
  result?: unknown;
  started_at?: string;
  ended_at?: string;
  latency_ms?: number;
  error?: string | { message?: string } | null;
}

interface Props {
  toolCalls: unknown;
  finalText?: string | null;
  emptyMessage?: string;
}

function asArray(input: unknown): ToolCallStep[] {
  if (!Array.isArray(input)) return [];
  return input.filter((x) => x && typeof x === "object") as ToolCallStep[];
}

function fmtJson(value: unknown): string {
  if (value === undefined || value === null) return "—";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function clip(text: string, max = 4000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n… (truncado)`;
}

export function RunTrace({ toolCalls, finalText, emptyMessage = "Sem trace disponível." }: Props) {
  const steps = asArray(toolCalls);

  if (steps.length === 0 && !finalText) {
    return <p className="text-sm text-muted-foreground">{emptyMessage}</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {steps.map((s, idx) => {
        const stepNum = s.step ?? idx + 1;
        const errMsg = typeof s.error === "string" ? s.error : (s.error?.message ?? null);
        return (
          <details
            key={`${stepNum}-${s.tool_name ?? idx}`}
            className="border-border/60 group rounded-md border bg-background"
          >
            <summary className="flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-sm">
              <span className="flex items-center gap-2">
                <Badge variant="outline" className="font-mono text-xs">
                  #{stepNum}
                </Badge>
                <span className="font-mono">{s.tool_name ?? "(sem nome)"}</span>
                {errMsg ? (
                  <Badge variant="destructive" className="text-xs">
                    erro
                  </Badge>
                ) : null}
              </span>
              <span className="text-xs text-muted-foreground">
                {typeof s.latency_ms === "number" ? `${s.latency_ms}ms` : "—"}
              </span>
            </summary>
            <div className="border-border/60 space-y-3 border-t px-3 py-3 text-xs">
              <div>
                <p className="mb-1 font-medium text-muted-foreground">Args</p>
                <pre className="bg-muted/40 overflow-x-auto rounded p-2 font-mono leading-relaxed">
                  {clip(fmtJson(s.args))}
                </pre>
              </div>
              <div>
                <p className="mb-1 font-medium text-muted-foreground">Result</p>
                <pre className="bg-muted/40 overflow-x-auto rounded p-2 font-mono leading-relaxed">
                  {clip(fmtJson(s.result))}
                </pre>
              </div>
              {errMsg ? (
                <div>
                  <p className="mb-1 font-medium text-destructive">Error</p>
                  <pre className="bg-destructive/10 overflow-x-auto rounded p-2 font-mono leading-relaxed text-destructive">
                    {clip(errMsg)}
                  </pre>
                </div>
              ) : null}
              <div className="text-muted-foreground">
                <span>{s.started_at ?? "—"}</span>
                <span className="mx-2">→</span>
                <span>{s.ended_at ?? "—"}</span>
              </div>
            </div>
          </details>
        );
      })}

      {finalText ? (
        <div className="border-primary/30 bg-primary/5 rounded-md border p-3 text-sm">
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-primary">
            Mensagem que SERIA enviada
          </p>
          <p className="whitespace-pre-wrap">{finalText}</p>
        </div>
      ) : null}
    </div>
  );
}
