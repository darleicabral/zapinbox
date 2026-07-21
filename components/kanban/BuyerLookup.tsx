"use client";
import { useMemo, useState } from "react";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSalesBase, type Sale } from "@/hooks/sales/useSalesBase";

interface Props {
  /** Só busca/renderiza quando o pipeline usa este fluxo (tem campo empreendimento). */
  enabled: boolean;
  /** Chamado quando o operador escolhe uma unidade → auto-preenche o formulário. */
  onSelect: (sale: Sale) => void;
  disabled?: boolean;
}

/**
 * Busca do comprador na base de vendas: dois menus em cascata
 * (Empreendimento → Unidade). Ao escolher a unidade, dispara onSelect com a
 * venda, que o diálogo usa para auto-preencher os campos do chamado.
 *
 * Convenção do fork: componente client NUNCA consulta supabase-js direto —
 * os dados vêm da rota /api/v1/sales (sessão via cookie).
 */
export function BuyerLookup({ enabled, onSelect, disabled = false }: Props) {
  const { data: sales, isLoading } = useSalesBase(enabled);
  const [empreendimento, setEmpreendimento] = useState("");
  const [unidadeId, setUnidadeId] = useState("");

  const empreendimentos = useMemo(() => {
    const set = new Set<string>();
    for (const s of sales ?? []) if (s.empreendimento) set.add(s.empreendimento);
    return Array.from(set).sort((a, b) => a.localeCompare(b, "pt-BR"));
  }, [sales]);

  const unidades = useMemo(() => {
    return (sales ?? [])
      .filter((s) => s.empreendimento === empreendimento && s.unidade)
      .sort((a, b) => (a.unidade ?? "").localeCompare(b.unidade ?? "", "pt-BR", { numeric: true }));
  }, [sales, empreendimento]);

  if (!enabled) return null;
  if (!isLoading && (sales?.length ?? 0) === 0) return null;

  function pickEmpreendimento(v: string) {
    setEmpreendimento(v);
    setUnidadeId("");
  }

  function pickUnidade(id: string) {
    setUnidadeId(id);
    const sale = unidades.find((s) => s.id === id);
    if (sale) onSelect(sale);
  }

  return (
    <div className="space-y-3 rounded-md border bg-muted/30 p-3">
      <div className="space-y-0.5">
        <Label className="text-sm font-medium">Buscar comprador (base de vendas)</Label>
        <p className="text-xs text-muted-foreground">
          Escolha o empreendimento e a unidade para preencher os dados automaticamente.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="buyer-emp" className="text-xs">Empreendimento</Label>
          <Select value={empreendimento} onValueChange={pickEmpreendimento} disabled={disabled || isLoading}>
            <SelectTrigger id="buyer-emp">
              <SelectValue placeholder={isLoading ? "Carregando…" : "Selecione…"} />
            </SelectTrigger>
            <SelectContent>
              {empreendimentos.map((e) => (
                <SelectItem key={e} value={e}>{e}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="buyer-unidade" className="text-xs">Unidade</Label>
          <Select
            value={unidadeId}
            onValueChange={pickUnidade}
            disabled={disabled || isLoading || !empreendimento}
          >
            <SelectTrigger id="buyer-unidade">
              <SelectValue placeholder={empreendimento ? "Selecione a unidade…" : "Escolha o empreendimento primeiro"} />
            </SelectTrigger>
            <SelectContent>
              {unidades.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.unidade}{s.cliente ? ` — ${s.cliente}` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}
