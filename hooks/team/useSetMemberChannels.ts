"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";

/**
 * Define quais números de WhatsApp o membro vê (0029).
 *
 * ⚠️ Lista **vazia** significa "sem restrição, vê todos" — não "não vê nenhum".
 * É o default de compatibilidade da migration; quem chamar precisa deixar isso
 * claro na tela, senão o gerente acha que está tirando acesso quando está dando.
 */
export function useSetMemberChannels() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { userId: string; channelSessionIds: string[] }) =>
      apiClient.patch<{ data: { user_id: string; channel_session_ids: string[] } }>(
        `/api/v1/team/${args.userId}/channels`,
        { channel_session_ids: args.channelSessionIds },
      ),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["team"] });
      // o próprio usuário pode ter mudado de escopo: recarrega o que depende disso
      qc.invalidateQueries({ queryKey: ["channel-sessions"] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["contacts"] });
    },
  });
}
