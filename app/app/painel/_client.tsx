"use client";
import { Card } from "@/components/ui/card";
import { usePosvendaReport } from "@/hooks/reports/usePosvendaReport";
import type { Bucket } from "@/lib/reports/posvenda";

type Accent = "red" | "amber" | "green" | undefined;
const ACCENT_HEX: Record<"red" | "amber" | "green", string> = {
  red: "#DC2626",
  amber: "#D97706",
  green: "#16A34A",
};

function Tile({
  label,
  value,
  accent,
  hint,
}: {
  label: string;
  value: number | string;
  accent?: Accent;
  hint?: string;
}) {
  return (
    <Card className="p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p
        className="mt-1 text-3xl font-semibold tabular-nums"
        style={accent ? { color: ACCENT_HEX[accent] } : undefined}
      >
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </Card>
  );
}

function BarList({ title, buckets }: { title: string; buckets: Bucket[] }) {
  const max = Math.max(1, ...buckets.map((b) => b.count));
  return (
    <Card className="p-4">
      <p className="mb-3 text-sm font-medium">{title}</p>
      {buckets.length === 0 ? (
        <p className="text-sm text-muted-foreground">Sem dados ainda.</p>
      ) : (
        <ul className="space-y-2">
          {buckets.map((b) => (
            <li key={b.label} className="space-y-1">
              <div className="flex items-center justify-between text-sm">
                <span className="truncate pr-2">{b.label}</span>
                <span className="tabular-nums text-muted-foreground">{b.count}</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${Math.round((b.count / max) * 100)}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function fmtDay(iso: string): string {
  const [, m, d] = iso.split("-");
  return d && m ? `${d}/${m}` : iso;
}

export function PosvendaClient({ orgName }: { orgName: string }) {
  const { data, isLoading, isError, refetch, isFetching } = usePosvendaReport();

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Painel de pós-venda</h1>
          <p className="text-sm text-muted-foreground">
            {orgName} · onda Van Gogh em tempo real{isFetching ? " · atualizando…" : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={() => refetch()}
          className="rounded-md border px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent/50 hover:text-foreground"
        >
          Atualizar
        </button>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Carregando…</p>}
      {isError && (
        <p className="text-sm text-destructive">
          Não foi possível carregar o painel. Tente atualizar.
        </p>
      )}

      {data && data.total === 0 && (
        <Card className="p-6">
          <p className="text-sm text-muted-foreground">
            Nenhum atendimento registrado ainda. Assim que a equipe abrir atendimentos no Kanban
            &quot;Atendimentos Pós-venda&quot;, os números da onda aparecem aqui.
          </p>
        </Card>
      )}

      {data && data.total > 0 && (
        <>
          <section>
            <h2 className="mb-3 text-sm font-medium text-muted-foreground">Termômetro da crise</h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              <Tile label="Intenção de distrato" value={data.distrato} accent="red" />
              <Tile label="Ameaças jurídicas" value={data.juridico} accent="red" />
              <Tile label="Perguntas sobre multa" value={data.multa} accent="amber" />
              <Tile label="Só querem nova previsão" value={data.so_previsao} accent="green" />
              <Tile
                label="Titulares no exterior"
                value={data.exterior}
                hint={`${Math.round((data.exterior / data.total) * 100)}% do total`}
              />
              <Tile
                label="Via representante/advogado"
                value={data.via_terceiro}
                hint={`${Math.round((data.via_terceiro / data.total) * 100)}% do total`}
              />
              <Tile label="Clientes reincidentes" value={data.reincidentes} />
              <Tile
                label="Vermelho / Amarelo"
                value={`${data.semaforo.vermelho} / ${data.semaforo.amarelo}`}
                hint={`Verde: ${data.semaforo.verde}`}
              />
            </div>
          </section>

          <section>
            <h2 className="mb-3 text-sm font-medium text-muted-foreground">Volume de atendimentos</h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Tile label="Total" value={data.total} />
              <Tile label="Abertos" value={data.abertos} />
              <Tile label="Concluídos" value={data.concluidos} />
              <Tile label="Cancelados" value={data.cancelados} />
            </div>
          </section>

          <section>
            <Card className="p-4">
              <p className="mb-3 text-sm font-medium">Curva da onda — Van Gogh por dia</p>
              {data.onda_vangogh.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Nenhum atendimento do Van Gogh ainda.
                </p>
              ) : (
                <ul className="space-y-2">
                  {data.onda_vangogh.map((d) => {
                    const max = Math.max(1, ...data.onda_vangogh.map((x) => x.count));
                    return (
                      <li key={d.date} className="flex items-center gap-3">
                        <span className="w-12 shrink-0 text-xs tabular-nums text-muted-foreground">
                          {fmtDay(d.date)}
                        </span>
                        <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${Math.round((d.count / max) * 100)}%`,
                              background: ACCENT_HEX.red,
                            }}
                          />
                        </div>
                        <span className="w-8 shrink-0 text-right text-sm tabular-nums">
                          {d.count}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          </section>

          <section className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <BarList title="Por categoria" buckets={data.por_categoria} />
            <BarList title="Por empreendimento" buckets={data.por_empreendimento} />
            <BarList title="Por canal" buckets={data.por_canal} />
            <BarList title="Impacto no planejamento (Van Gogh)" buckets={data.vg_impacto} />
          </section>
        </>
      )}
    </div>
  );
}
