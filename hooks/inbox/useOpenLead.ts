"use client";
import { useMutation } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { NewLeadHandoffContact } from "@/lib/kanban/new-lead-handoff";

interface OpenLeadArgs {
  conversation_id: string;
}

/**
 * Resposta de "Abrir atendimento": para onde ir. Se `lead_id` vier preenchido,
 * o contato já tem atendimento aberto (reincidente) e a atendente vai pra ele;
 * senão abre-se a tela de Novo Atendimento com `title`/`prefill`/`contact`.
 */
export interface OpenLeadTargetResult {
  pipeline_id: string;
  lead_id: string | null;
  external_id: string | null;
  reincidente: boolean;
  title: string;
  description?: string | null;
  prefill: Record<string, unknown>;
  contact: NewLeadHandoffContact;
}

/** Resolve o destino do "Abrir atendimento" a partir de uma conversa do Inbox. */
export function useOpenLead() {
  return useMutation({
    mutationFn: async (args: OpenLeadArgs) =>
      apiClient.post<{ data: OpenLeadTargetResult }>(
        `/api/v1/conversations/${args.conversation_id}/open-lead`,
        {},
      ),
    onError: (err) => showApiError(err),
  });
}
