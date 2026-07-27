"use client";
/**
 * Importação de contatos em lote. Manda as linhas já parseadas (lib/contacts/csv.ts)
 * em blocos, para não estourar o tempo da função serverless nem o payload, e
 * soma o resultado dos blocos.
 */
import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { ParsedContactRow } from "@/lib/contacts/csv";

const CHUNK = 300;

export interface ImportSummary {
  created: number;
  updated: number;
  unchanged: number;
  errors: Array<{ line?: number; message: string }>;
}

interface ChunkResponse {
  data: ImportSummary;
}

export function useImportContacts() {
  const qc = useQueryClient();
  const [isPending, setIsPending] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 });

  const run = useCallback(
    async (rows: ParsedContactRow[]): Promise<ImportSummary | null> => {
      const payload = rows.map((r) => ({
        line: r.line,
        name: r.name,
        phone: r.phone,
        email: r.email,
        empreendimento: r.empreendimento,
      }));

      setIsPending(true);
      setProgress({ done: 0, total: payload.length });
      const total: ImportSummary = { created: 0, updated: 0, unchanged: 0, errors: [] };
      try {
        for (let i = 0; i < payload.length; i += CHUNK) {
          const part = payload.slice(i, i + CHUNK);
          const res = await apiClient.post<ChunkResponse>("/api/v1/contacts/import", {
            rows: part,
          });
          total.created += res.data.created;
          total.updated += res.data.updated;
          total.unchanged += res.data.unchanged;
          total.errors.push(...res.data.errors);
          setProgress({ done: Math.min(i + CHUNK, payload.length), total: payload.length });
        }
        qc.invalidateQueries({ queryKey: ["contacts"] });
        return total;
      } catch (err) {
        showApiError(err);
        return null;
      } finally {
        setIsPending(false);
      }
    },
    [qc],
  );

  return { run, isPending, progress };
}
