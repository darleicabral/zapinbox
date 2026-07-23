"use client";
import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MagnifyingGlass } from "@/lib/ui/icons";
import { useSalesBase, type Sale } from "@/hooks/sales/useSalesBase";

/** Agregado do comprador (todas as unidades do mesmo CPF/nome). */
export interface BuyerAggregate {
  units: number;
  totalCents: number;
  unidades: string[];
}

interface Props {
  /** Só busca/renderiza quando o pipeline usa este fluxo (tem campo empreendimento). */
  enabled: boolean;
  /** Chamado quando o operador escolhe um comprador → auto-preenche o formulário. */
  onSelect: (sale: Sale, aggregate: BuyerAggregate) => void;
  disabled?: boolean;
}

function norm(s: string): string {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();
}
function digitsOf(s: string | null | undefined): string {
  return (s ?? "").replace(/\D/g, "");
}
/** Chave de identidade do comprador: CPF (dígitos) ou, se faltar, o nome normalizado. */
function clientKey(s: Sale): string {
  return digitsOf(s.cpf) || norm(s.cliente ?? "");
}

/**
 * Busca do comprador na base de vendas: por nome/CPF (caixa de busca) OU por
 * Empreendimento → Unidade (menus em cascata). Ao escolher, dispara onSelect com
 * a venda + o agregado do cliente (nº de unidades e valor total somado).
 *
 * Convenção do fork: componente client NUNCA consulta supabase-js direto —
 * os dados vêm da rota /api/v1/sales (sessão via cookie).
 */
export function BuyerLookup({ enabled, onSelect, disabled = false }: Props) {
  const { data: sales, isLoading } = useSalesBase(enabled);
  const [search, setSearch] = useState("");
  const [empreendimento, setEmpreendimento] = useState("");
  const [unidadeId, setUnidadeId] = useState("");
  const [picked, setPicked] = useState<string | null>(null);

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

  const searchResults = useMemo(() => {
    const term = search.trim();
    if (term.length < 2) return [];
    const nt = norm(term);
    const dt = digitsOf(term);
    return (sales ?? [])
      .filter((s) => {
        const byName = s.cliente ? norm(s.cliente).includes(nt) : false;
        const byCpf = dt.length >= 3 && s.cpf ? digitsOf(s.cpf).includes(dt) : false;
        return byName || byCpf;
      })
      .slice(0, 8);
  }, [sales, search]);

  if (!enabled) return null;
  if (!isLoading && (sales?.length ?? 0) === 0) return null;

  function aggregateFor(sale: Sale): BuyerAggregate {
    const key = clientKey(sale);
    const group = key ? (sales ?? []).filter((s) => clientKey(s) === key) : [sale];
    const totalCents = group.reduce((sum, s) => sum + (s.valor_cents ?? 0), 0);
    const unidadesList = group
      .map((s) => [s.empreendimento, s.unidade].filter(Boolean).join(" "))
      .filter(Boolean);
    return { units: group.length || 1, totalCents, unidades: unidadesList };
  }

  function pick(sale: Sale) {
    onSelect(sale, aggregateFor(sale));
    setPicked(sale.cliente ?? sale.unidade ?? "comprador");
    setSearch("");
    setEmpreendimento(sale.empreendimento ?? "");
    setUnidadeId(sale.id);
  }

  function pickEmpreendimento(v: string) {
    setEmpreendimento(v);
    setUnidadeId("");
  }
  function pickUnidade(id: string) {
    setUnidadeId(id);
    const sale = unidades.find((s) => s.id === id);
    if (sale) pick(sale);
  }

  return (
    <div className="space-y-3.5 rounded-xl border-2 border-accent/40 bg-accent-soft/60 p-4 shadow-sm ring-1 ring-accent/10">
      <div className="flex items-start gap-2.5">
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground shadow-sm"
          aria-hidden
        >
          <MagnifyingGlass size={17} weight="bold" />
        </span>
        <div className="space-y-0.5">
          <Label className="text-sm font-semibold text-text">Buscar comprador na base de vendas</Label>
          <p className="text-xs text-muted-foreground">
            Comece por aqui: os dados do atendimento são preenchidos automaticamente.
          </p>
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="relative">
          <MagnifyingGlass
            size={18}
            weight="bold"
            aria-hidden
            className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-accent"
          />
          <Input
            placeholder="Nome do cliente ou CPF…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            disabled={disabled || isLoading}
            autoComplete="off"
            className="h-12 rounded-lg border-accent/40 bg-surface pl-11 text-[15px] shadow-sm placeholder:text-text-subtle hover:border-accent/60 focus-visible:border-accent focus-visible:ring-accent/25"
          />
        </div>
        {search.trim().length >= 2 && (
          <div className="max-h-44 overflow-y-auto rounded-lg border border-border bg-surface shadow-md">
            {searchResults.length === 0 ? (
              <p className="px-3 py-2 text-sm text-muted-foreground">Nenhum comprador encontrado.</p>
            ) : (
              searchResults.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => pick(s)}
                  disabled={disabled}
                  className="flex w-full flex-col items-start px-3 py-2 text-left transition-colors hover:bg-accent-soft"
                >
                  <span className="text-sm font-medium">{s.cliente ?? "(sem nome)"}</span>
                  <span className="text-xs text-muted-foreground">
                    {[s.empreendimento, s.unidade].filter(Boolean).join(" · ")}
                    {s.cpf ? ` · ${s.cpf}` : ""}
                  </span>
                </button>
              ))
            )}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2.5" aria-hidden>
        <span className="h-px flex-1 bg-accent/20" />
        <span className="text-[10px] font-medium uppercase tracking-wide text-accent/80">ou por unidade</span>
        <span className="h-px flex-1 bg-accent/20" />
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

      {picked && (
        <p className="text-xs text-muted-foreground">✓ Dados preenchidos a partir de: <span className="font-medium">{picked}</span></p>
      )}
    </div>
  );
}
