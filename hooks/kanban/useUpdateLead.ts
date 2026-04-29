"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { Lead } from "@/lib/types/leads";

interface WinArgs {
  leadId: string;
}
interface LoseArgs {
  leadId: string;
  lostReason: string;
}

export function useWinLead(pipelineId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ leadId }: WinArgs) =>
      apiClient.post<{ data: Lead }>(`/api/v1/leads/${leadId}/win`, {}),
    onError: showApiError,
    onSettled: () => qc.invalidateQueries({ queryKey: ["board", pipelineId] }),
  });
}

export function useLoseLead(pipelineId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ leadId, lostReason }: LoseArgs) =>
      apiClient.post<{ data: Lead }>(`/api/v1/leads/${leadId}/lose`, {
        lost_reason: lostReason,
      }),
    onError: showApiError,
    onSettled: () => qc.invalidateQueries({ queryKey: ["board", pipelineId] }),
  });
}
