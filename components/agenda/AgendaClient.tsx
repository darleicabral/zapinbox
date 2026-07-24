"use client";
import { useMemo, useState } from "react";
import type { CSSProperties } from "react";

import { useBoard } from "@/hooks/kanban/useBoard";
import { useUser, useActiveOrg } from "@/hooks/auth/AuthProvider";
import { hasPosvendaModule } from "@/lib/modules";
import { EditLeadDialog } from "@/components/kanban/EditLeadDialog";
import { Calendar, CaretRight } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";
import type { Lead } from "@/lib/types/leads";
import type { Stage } from "@/lib/kanban/types";

/** Cor do nível de acompanhamento — mesma linguagem visual dos cards do board. */
const NIVEL_COLOR: Record<string, string> = {
  Vermelho: "var(--color-error)",
  Amarelo: "var(--color-warning)",
  Verde: "var(--color-success)",
};

type BucketKey = "atrasado" | "hoje" | "amanha" | "semana" | "depois";

const BUCKET_ORDER: BucketKey[] = ["atrasado", "hoje", "amanha", "semana", "depois"];
const BUCKET_LABEL: Record<BucketKey, string> = {
  atrasado: "Atrasados",
  hoje: "Hoje",
  amanha: "Amanhã",
  semana: "Próximos 7 dias",
  depois: "Depois",
};

interface AgendaItem {
  lead: Lead;
  due: Date;
  overdueDays: number;
}

const weekdayFmt = new Intl.DateTimeFormat("pt-BR", { weekday: "short" });
const monthFmt = new Intl.DateTimeFormat("pt-BR", { month: "short" });

/** Lê "YYYY-MM-DD" como data local (meia-noite), ignorando timezone. */
function parseLocalDate(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function startOfToday(): Date {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}

function bucketFor(diffDays: number): BucketKey {
  if (diffDays < 0) return "atrasado";
  if (diffDays === 0) return "hoje";
  if (diffDays === 1) return "amanha";
  if (diffDays <= 7) return "semana";
  return "depois";
}

function cleanWeekday(d: Date): string {
  // pt-BR devolve "seg." — tira o ponto e capitaliza.
  const s = weekdayFmt.format(d).replace(".", "");
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function cleanMonth(d: Date): string {
  return monthFmt.format(d).replace(".", "").toUpperCase();
}

export function AgendaClient({ pipelineId }: { pipelineId: string }) {
  const { data, isLoading, error } = useBoard(pipelineId);
  const user = useUser();
  const [scope, setScope] = useState<"todos" | "meus">("todos");
  // Atendente único (pós-venda): "Meus" == "Todos", então o alternador some.
  const isPosvenda = hasPosvendaModule(useActiveOrg()?.orgId);
  const [selected, setSelected] = useState<Lead | null>(null);

  const leadNoun = data?.pipeline.vocabulary?.lead ?? "Atendimento";

  const stageById = useMemo(() => {
    const m = new Map<string, Stage>();
    for (const s of data?.stages ?? []) m.set(s.id, s);
    return m;
  }, [data]);

  const buckets = useMemo(() => {
    const today = startOfToday();
    const rows: Array<AgendaItem & { bkt: BucketKey }> = [];
    for (const lead of data?.leads ?? []) {
      if (lead.status !== "open") continue;
      if (scope === "meus" && lead.owner_user_id !== user.id) continue;
      const due = parseLocalDate((lead.custom_fields ?? {})["proximo_contato"]);
      if (!due) continue;
      const diff = Math.round((due.getTime() - today.getTime()) / 86_400_000);
      rows.push({ lead, due, overdueDays: diff < 0 ? -diff : 0, bkt: bucketFor(diff) });
    }
    rows.sort((a, b) => a.due.getTime() - b.due.getTime());
    return BUCKET_ORDER.map((key) => ({
      key,
      label: BUCKET_LABEL[key],
      items: rows.filter((r) => r.bkt === key) as AgendaItem[],
    })).filter((b) => b.items.length > 0);
  }, [data, scope, user.id]);

  const total = buckets.reduce((n, b) => n + b.items.length, 0);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-start gap-3">
          <span
            className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent"
            aria-hidden
          >
            <Calendar size={22} weight="duotone" />
          </span>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Agenda</h1>
            <p className="text-sm text-muted-foreground">
              Atendimentos com próximo contato agendado — as tarefas do dia.
            </p>
          </div>
        </div>

        {!isPosvenda && (
          <div className="inline-flex rounded-lg border border-border bg-surface-muted p-0.5 text-sm">
            {(["todos", "meus"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setScope(s)}
                className={cn(
                  "rounded-md px-3 py-1 transition-colors duration-fast ease-out",
                  scope === s
                    ? "bg-surface font-medium text-text shadow-xs"
                    : "text-text-muted hover:text-text",
                )}
              >
                {s === "todos" ? "Todos" : "Meus"}
              </button>
            ))}
          </div>
        )}
      </header>

      {error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm">
          Erro ao carregar a agenda.
        </div>
      ) : isLoading || !data ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded-lg border border-border bg-surface-muted" />
          ))}
        </div>
      ) : total === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-surface-muted/60 px-6 py-16 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-surface text-text-subtle">
            <Calendar size={24} weight="duotone" />
          </span>
          <div className="space-y-1">
            <p className="text-sm font-medium text-text">Nada agendado</p>
            <p className="text-sm text-muted-foreground">
              {scope === "meus"
                ? "Você não tem próximos contatos agendados."
                : `Defina o "Próximo contato" num ${leadNoun.toLowerCase()} para ele aparecer aqui.`}
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          {buckets.map((bucket) => (
            <section key={bucket.key} className="space-y-2">
              <div className="flex items-center gap-2 px-0.5">
                <h2
                  className={cn(
                    "text-xs font-semibold uppercase tracking-wide",
                    bucket.key === "atrasado" ? "text-error-fg" : "text-text-muted",
                  )}
                >
                  {bucket.label}
                </h2>
                <span className="rounded-full bg-surface-elevated px-1.5 text-[11px] font-medium tabular-nums text-text-muted">
                  {bucket.items.length}
                </span>
              </div>

              <ul className="space-y-2">
                {bucket.items.map(({ lead, due, overdueDays }) => (
                  <li key={lead.id}>
                    <AgendaRow
                      lead={lead}
                      due={due}
                      overdueDays={overdueDays}
                      stage={stageById.get(lead.stage_id) ?? null}
                      onOpen={() => setSelected(lead)}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {selected && (
        <EditLeadDialog
          open
          onOpenChange={(v) => !v && setSelected(null)}
          lead={selected}
          pipelineId={pipelineId}
        />
      )}
    </div>
  );
}

function AgendaRow({
  lead,
  due,
  overdueDays,
  stage,
  onOpen,
}: {
  lead: Lead;
  due: Date;
  overdueDays: number;
  stage: Stage | null;
  onOpen: () => void;
}) {
  const cf = lead.custom_fields ?? {};
  const nivel = typeof cf["nivel_acompanhamento"] === "string" ? (cf["nivel_acompanhamento"] as string) : null;
  const nivelColor = nivel ? NIVEL_COLOR[nivel] : undefined;
  const contactName = lead.contact?.display_name?.trim() || lead.contact?.name?.trim() || null;
  const isOverdue = overdueDays > 0;

  const barStyle: CSSProperties | undefined = nivelColor ? { backgroundColor: nivelColor } : undefined;
  const dotStyle: CSSProperties | undefined = stage?.color ? { backgroundColor: stage.color } : undefined;

  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "group relative flex w-full items-center gap-3 overflow-hidden rounded-lg border border-border bg-surface py-2.5 pl-3.5 pr-3 text-left shadow-xs",
        "transition-[border-color,box-shadow,transform] duration-fast ease-out",
        "hover:border-border-strong hover:shadow-sm active:scale-[0.997]",
      )}
    >
      {nivelColor && (
        <span aria-hidden className="absolute inset-y-0 left-0 w-1" style={barStyle} />
      )}

      {/* Data */}
      <div
        className={cn(
          "flex w-14 shrink-0 flex-col items-center rounded-md px-1 py-1.5 text-center",
          isOverdue ? "bg-error-bg text-error-fg" : "bg-surface-muted text-text",
        )}
      >
        <span className="text-[10px] font-medium uppercase leading-none opacity-80">
          {cleanWeekday(due)}
        </span>
        <span className="text-base font-semibold leading-tight tabular-nums">{due.getDate()}</span>
        <span className="text-[10px] font-medium uppercase leading-none opacity-80">
          {cleanMonth(due)}
        </span>
      </div>

      {/* Conteúdo */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {lead.external_id && (
            <span className="shrink-0 text-[10px] font-medium uppercase tabular-nums text-text-subtle">
              {lead.external_id}
            </span>
          )}
          <h3 className="truncate text-sm font-medium text-text">{lead.title}</h3>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-text-muted">
          {contactName && <span className="truncate">{contactName}</span>}
          {contactName && stage && <span aria-hidden className="text-text-subtle">·</span>}
          {stage && (
            <span className="inline-flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-text-muted/40" style={dotStyle} aria-hidden />
              {stage.name}
            </span>
          )}
          {isOverdue && (
            <span className="font-medium text-error-fg">
              · atrasado {overdueDays} {overdueDays === 1 ? "dia" : "dias"}
            </span>
          )}
        </div>
      </div>

      <CaretRight
        size={16}
        aria-hidden
        className="shrink-0 text-text-subtle transition-transform duration-fast ease-out group-hover:translate-x-0.5"
      />
    </button>
  );
}
