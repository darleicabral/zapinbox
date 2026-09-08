"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { LeadSemCorretor } from "@/lib/attendance/fila-parada";

export type JanelaFila = 1 | 7 | 30;

interface RespostaFila {
  dias: number;
  total: number;
  leads: LeadSemCorretor[];
}

export function useFilaSemCorretor(dias: JanelaFila) {
  return useQuery({
    queryKey: ["attendance", "sem-corretor", dias],
    queryFn: async () => {
      try {
        const res = await apiClient.get<{ data: RespostaFila }>(
          `/api/v1/conversations/sem-corretor?dias=${dias}`,
        );
        return res.data;
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
    refetchOnWindowFocus: true,
  });
}

export interface ResultadoDistribuicao {
  distribuidos: { conversation_id: string; assigned_to: string; notified: boolean }[];
  pulados: { conversation_id: string; motivo: string }[];
}

export function useDistribuirLeads() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { conversationIds: string[]; userId?: string }) => {
      const res = await apiClient.post<{ data: ResultadoDistribuicao }>(
        "/api/v1/conversations/sem-corretor",
        { conversation_ids: args.conversationIds, user_id: args.userId },
      );
      return res.data;
    },
    onError: (err) => showApiError(err),
    onSuccess: () => {
      // A fila encurta e o painel por corretor sobe: os dois vêm do servidor.
      void qc.invalidateQueries({ queryKey: ["attendance", "sem-corretor"] });
      void qc.invalidateQueries({ queryKey: ["reports", "distribuicao"] });
      void qc.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}
