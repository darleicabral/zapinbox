"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";

interface OpenLeadArgs {
  conversation_id: string;
}

export interface OpenLeadResult {
  lead_id: string;
  pipeline_id: string;
  title: string;
  external_id: string | null;
  created: boolean;
  reincidente: boolean;
}

/** Abre um atendimento a partir da conversa (criação MANUAL + dedupe reincidente). */
export function useOpenLead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: OpenLeadArgs) =>
      apiClient.post<{ data: OpenLeadResult }>(
        `/api/v1/conversations/${args.conversation_id}/open-lead`,
        {},
      ),
    onError: (err) => showApiError(err),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["board"] });
      qc.invalidateQueries({ queryKey: ["leads"] });
    },
  });
}
