"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";

/**
 * Pausa (data futura) ou reativa (null) um membro no rodízio de leads.
 * A data é ISO; passou o prazo, o membro volta ao rodízio sozinho.
 */
export function useSetRotationPause() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { userId: string; pausedUntil: string | null }) =>
      apiClient.patch<{ data: { user_id: string; rotation_paused_until: string | null } }>(
        `/api/v1/team/${args.userId}/rotation`,
        { paused_until: args.pausedUntil },
      ),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["team"] });
    },
  });
}
