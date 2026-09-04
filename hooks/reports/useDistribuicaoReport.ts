"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { DistribuicaoReport } from "@/lib/reports/distribuicao";

export type JanelaDistribuicao = 0 | 7 | 30;

export function useDistribuicaoReport(dias: JanelaDistribuicao) {
  return useQuery({
    queryKey: ["reports", "distribuicao", dias],
    queryFn: async () => {
      try {
        const res = await apiClient.get<{ data: DistribuicaoReport }>(
          `/api/v1/reports/distribuicao?dias=${dias}`,
        );
        return res.data;
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
    // "De preferência em tempo real" (Darlei, 04/09/2026). 20s é o suficiente
    // pra acompanhar a distribuição acontecendo sem martelar o banco.
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
  });
}
