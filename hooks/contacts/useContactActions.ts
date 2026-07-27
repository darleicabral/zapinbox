"use client";
/**
 * Ações da lista de Contatos (pós-venda): abrir atendimento e abrir a conversa
 * de WhatsApp do contato. Ambas devolvem o destino — quem chama navega.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { OpenLeadTargetResult } from "@/hooks/inbox/useOpenLead";

/** Resolve o destino do "Abrir atendimento" a partir do contato. */
export function useOpenContactLead() {
  return useMutation({
    mutationFn: async (contactId: string) =>
      apiClient.post<{ data: OpenLeadTargetResult }>(`/api/v1/contacts/${contactId}/open-lead`, {}),
    onError: (err) => showApiError(err),
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
