"use client";
/**
 * Ações da lista de Contatos (pós-venda): abrir atendimento e abrir a conversa
 * de WhatsApp do contato. Ambas devolvem o id de destino — quem chama navega.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { OpenLeadResult } from "@/hooks/inbox/useOpenLead";

/** Cria (ou reaproveita, se reincidente) o atendimento do contato. */
export function useOpenContactLead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (contactId: string) =>
      apiClient.post<{ data: OpenLeadResult }>(`/api/v1/contacts/${contactId}/open-lead`, {}),
    onError: (err) => showApiError(err),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["board"] });
      qc.invalidateQueries({ queryKey: ["leads"] });
    },
  });
}

export interface ContactConversationResult {
  conversation_id: string;
  created: boolean;
}

/** Resolve/cria a conversa de WhatsApp do contato (abre no nosso Inbox). */
export function useContactConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (contactId: string) =>
      apiClient.post<{ data: ContactConversationResult }>(
        `/api/v1/contacts/${contactId}/conversation`,
        {},
      ),
    onError: (err) => showApiError(err),
    onSuccess: (res) => {
      if (res.data.created) qc.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}
