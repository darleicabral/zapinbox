"use client";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  useDistribuicaoReport,
  type JanelaDistribuicao,
} from "@/hooks/reports/useDistribuicaoReport";
import type { LinhaCorretor } from "@/lib/reports/distribuicao";

const JANELAS: { v: JanelaDistribuicao; label: string }[] = [
  { v: 0, label: "Hoje" },
  { v: 7, label: "7 dias" },
  { v: 30, label: "30 dias" },
];

function Tile({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <Card className="p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 text-3xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </Card>
  );
}

/** Barra proporcional ao maior volume, pra comparar de relance. */
function Linha({ c, max }: { c: LinhaCorretor; max: number }) {
  const largura = max > 0 ? Math.max(2, Math.round((c.recebidos / max) * 100)) : 2;
  return (
    <div className="border-b border-border/60 py-3 last:border-0">
      <div className="flex items-baseline justify-between gap-3">
        <p className="truncate text-sm font-medium">
          {c.nome}
          {c.semTelefone && (
            <span className="ml-2 rounded bg-warning-bg px-1.5 py-0.5 text-xs text-warning-fg">
              sem telefone de aviso
            </span>
          )}
        </p>
        <p className="shrink-0 text-lg font-semibold tabular-nums">
          {c.recebidos}
          <span className="ml-1.5 text-xs font-normal text-muted-foreground">{c.fatiaPct}%</span>
        </p>
      </div>
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded bg-muted">
        <div className="h-full rounded bg-primary" style={{ width: `${largura}%` }} />
      </div>
    </div>
  );
}

export function DistribuicaoClient() {
  const [dias, setDias] = useState<JanelaDistribuicao>(0);
  const { data, isLoading, isFetching } = useDistribuicaoReport(dias);

  const linhas = data?.corretores ?? [];
  const max = Math.max(0, ...linhas.map((c) => c.recebidos));
  const semTelefone = linhas.filter((c) => c.semTelefone).length;
  const comLead = linhas.filter((c) => c.recebidos > 0).length;

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Distribuição de leads</h1>
          <p className="text-sm text-muted-foreground">
            Quantos leads foram enviados para cada corretor. Atualiza sozinho.
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {JANELAS.map((j) => (
            <Button
              key={j.v}
              size="sm"
              variant={dias === j.v ? "default" : "outline"}
              onClick={() => setDias(j.v)}
            >
              {j.label}
            </Button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Leads enviados" value={data?.total ?? (isLoading ? "…" : 0)} />
        <Tile label="Corretores com lead" value={comLead} hint={`de ${linhas.length} na equipe`} />
        <Tile
          label="Sem telefone de aviso"
          value={semTelefone}
          hint="não recebem o WhatsApp"
        />
        <Tile
          label="Fora da equipe"
          value={data?.foraDaEquipe ?? 0}
          hint="atribuídos a quem saiu"
        />
      </div>

      <Card className="p-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-medium">Por corretor</h2>
          {isFetching && <span className="text-xs text-muted-foreground">atualizando…</span>}
        </div>
        {isLoading ? (
          <p className="py-6 text-sm text-muted-foreground">Carregando…</p>
        ) : linhas.length === 0 ? (
          <p className="py-6 text-sm text-muted-foreground">
            Nenhum corretor cadastrado com papel de atendimento.
          </p>
        ) : (
          linhas.map((c) => <Linha key={c.userId} c={c} max={max} />)
        )}
      </Card>

      <p className="text-xs text-muted-foreground">
        A conta é por <strong>envio</strong>: desde 04/09 o lead não passa adiante, então quem foi
        atribuído é quem foi avisado. O que o corretor faz depois acontece no WhatsApp dele e não
        passa pelo CRM, então este painel para no envio de propósito. Corretor marcado como sem
        telefone recebe o lead no sistema, mas não recebe o aviso.
      </p>
    </div>
  );
}
