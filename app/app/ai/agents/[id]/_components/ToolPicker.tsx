"use client";
import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";

export interface McpToolMeta {
  id: string;
  description: string;
  category: "read" | "write" | "special" | string;
  requires_role: string;
  requires_scope: string;
}

interface Props {
  value: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}

interface ApiResponse {
  data: { tools: McpToolMeta[] };
}

const CATEGORY_LABELS: Record<string, string> = {
  read: "Leitura",
  write: "Escrita",
  special: "Especiais",
};

export function ToolPicker({ value, onChange, disabled }: Props) {
  const query = useQuery({
    queryKey: ["mcp", "tools"],
    queryFn: async () => {
      const res = await apiClient.get<ApiResponse>("/api/v1/mcp/tools");
      return res.data.tools;
    },
    staleTime: 60_000,
  });

  const grouped = React.useMemo(() => {
    const tools = query.data ?? [];
    const map = new Map<string, McpToolMeta[]>();
    for (const t of tools) {
      const k = t.category || "other";
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(t);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [query.data]);

  function toggle(id: string) {
    if (value.includes(id)) onChange(value.filter((x) => x !== id));
    else onChange([...value, id]);
  }

  if (query.isLoading) {
    return <p className="text-sm text-muted-foreground">Carregando catálogo de tools…</p>;
  }
  if (query.isError) {
    return <p className="text-sm text-destructive">Erro ao carregar tools.</p>;
  }

  return (
    <div className="space-y-4">
      {grouped.map(([category, list]) => (
        <fieldset key={category} className="border-border/60 space-y-2 rounded-md border p-3">
          <legend className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {CATEGORY_LABELS[category] ?? category}
          </legend>
          {list.map((t) => {
            const checked = value.includes(t.id);
            return (
              <label
                key={t.id}
                className="hover:bg-muted/40 flex cursor-pointer items-start gap-2 rounded p-1"
              >
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 rounded border-border accent-primary"
                  checked={checked}
                  onChange={() => toggle(t.id)}
                  disabled={disabled}
                  aria-label={t.id}
                />
                <span className="flex-1">
                  <code className="font-mono text-xs">{t.id}</code>
                  <span className="block text-xs text-muted-foreground">{t.description}</span>
                </span>
              </label>
            );
          })}
        </fieldset>
      ))}
      {value.length > 20 ? (
        <p className="text-xs text-destructive">Máximo de 20 tools por agent.</p>
      ) : null}
    </div>
  );
}
