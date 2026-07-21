"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

/** Uma venda da base (crm_products kind='venda') — comprador + unidade. */
export interface Sale {
  id: string;
  empreendimento: string | null;
  unidade: string | null;
  cliente: string | null;
  phone_e164: string | null;
  email: string | null;
  cpf: string | null;
  corretor: string | null;
  imobiliaria: string | null;
  profissao: string | null;
  tipo_unidade: string | null;
  intencao_compra: string | null;
  valor_cents: number | null;
}

/**
 * Carrega a base de vendas da org ativa (para o auto-preenchimento de chamados).
 * Volume pequeno → busca tudo de uma vez e a UI filtra em memória.
 * `enabled=false` quando o pipeline não usa esse fluxo (sem campo empreendimento).
 */
export function useSalesBase(enabled = true) {
  return useQuery({
    queryKey: ["sales-base"],
    enabled,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const res = await apiClient.get<{ data: Sale[] }>("/api/v1/sales");
      return res.data;
    },
  });
}
