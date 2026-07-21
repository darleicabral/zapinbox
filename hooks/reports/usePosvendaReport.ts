"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { PosvendaReport } from "@/lib/reports/posvenda";

export function usePosvendaReport() {
  return useQuery({
    queryKey: ["reports", "posvenda"],
    queryFn: async () => {
      try {
        const res = await apiClient.get<{ data: PosvendaReport }>("/api/v1/reports/posvenda");
        return res.data;
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
    // Painel de crise: atualiza sozinho enquanto a onda corre.
    refetchInterval: 60_000,
  });
}
