"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { BudgetStatus } from "@/lib/ai/budget/check";

export type { BudgetStatus };

export interface BudgetPatch {
  monthly_limit_cents?: number;
  alarm_threshold_pct?: number;
  action_at_100pct?: "throttle" | "disable";
}

interface SingleResponse {
  data: BudgetStatus;
}

export const aiBudgetQueryKey = ["ai", "budget"] as const;

export function useAiBudget(opts?: { initialData?: BudgetStatus }) {
  return useQuery({
    queryKey: aiBudgetQueryKey,
    queryFn: async () => {
      try {
        const res = await apiClient.get<SingleResponse>("/api/v1/ai/budget");
        return res.data;
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
    initialData: opts?.initialData,
    staleTime: 30_000,
  });
}

export function useUpdateBudget() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ["ai", "budget", "update"],
    mutationFn: async (patch: BudgetPatch) => {
      const res = await apiClient.patch<SingleResponse>("/api/v1/ai/budget", patch);
      return res.data;
    },
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: aiBudgetQueryKey });
      const previous = qc.getQueryData<BudgetStatus>(aiBudgetQueryKey);
      if (previous) {
        const optimistic: BudgetStatus = {
          ...previous,
          ...(patch.monthly_limit_cents !== undefined
            ? { monthly_limit_cents: patch.monthly_limit_cents }
            : {}),
          ...(patch.alarm_threshold_pct !== undefined
            ? { alarm_threshold_pct: patch.alarm_threshold_pct }
            : {}),
          ...(patch.action_at_100pct !== undefined
            ? { action_at_100pct: patch.action_at_100pct }
            : {}),
        };
        qc.setQueryData(aiBudgetQueryKey, optimistic);
      }
      return { previous };
    },
    onError: (err, _patch, context) => {
      if (context?.previous) {
        qc.setQueryData(aiBudgetQueryKey, context.previous);
      }
      showApiError(err);
    },
    onSuccess: (data) => {
      qc.setQueryData(aiBudgetQueryKey, data);
      toast.success("Orçamento atualizado");
    },
  });
}
