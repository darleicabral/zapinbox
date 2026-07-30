"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";

export interface SkippedContact {
  id: string;
  name: string;
  /** Motivo em português, já pronto pra mostrar ("tem conversa"). */
  reason: string;
}

export interface BulkDeleteResult {
  deleted: string[];
  skipped: SkippedContact[];
}

/**
 * Apaga contatos selecionados. A rota **recusa quem tem histórico** (conversa,
 * mensagem ou atendimento) e devolve em `skipped` — quem chama precisa mostrar,
 * senão o usuário acha que apagou tudo. Ver a rota pro motivo (FKs RESTRICT).
 */
export function useDeleteContacts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (ids: string[]) =>
      apiClient.post<{ data: BulkDeleteResult }>("/api/v1/contacts/bulk-delete", { ids }),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contacts"] });
    },
  });
}
