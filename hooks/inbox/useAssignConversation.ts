"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { Conversation } from "@/lib/types/messaging";

interface AssignArgs {
  conversation_id: string;
  user_id: string;
  /** Só pro texto do aviso na tela. */
  nome_do_corretor: string;
}

/**
 * Atribuição MANUAL: o gestor escolhe o corretor e o corretor recebe o aviso no
 * WhatsApp. Serve pro acervo parado, que o rodízio automático não alcança.
 *
 * O retorno traz `notified`: a atribuição vale mesmo se o aviso não sair (ex.:
 * corretor sem telefone cadastrado), e a mensagem na tela diz qual foi o caso —
 * senão o gestor acha que avisou e não avisou.
 */
export function useAssignConversation() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (args: AssignArgs) =>
      apiClient.post<{ data: Conversation & { notified?: boolean } }>(
        `/api/v1/conversations/${args.conversation_id}/assign`,
        { user_id: args.user_id },
      ),
    onError: (err) => showApiError(err),
    onSuccess: (resp, args) => {
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["conversation", args.conversation_id] });
      const avisou = resp?.data?.notified !== false;
      if (avisou) {
        toast.success(`Atribuído a ${args.nome_do_corretor}, que foi avisado no WhatsApp`);
      } else {
        toast.warning(
          `Atribuído a ${args.nome_do_corretor}, mas o aviso não saiu. Confira o telefone dele em Equipe.`,
        );
      }
    },
  });
}
