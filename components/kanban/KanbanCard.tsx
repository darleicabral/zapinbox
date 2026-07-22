"use client";
import { Draggable } from "@hello-pangea/dnd";
import type { MouseEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { House } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";
import type { Lead } from "@/lib/types/leads";
import { KanbanCardActions } from "./KanbanCardActions";

/** Cor do nível de acompanhamento (custom_fields.nivel_acompanhamento) — vira
 * uma linha na borda inferior do card em vez de um badge de texto. Usa os
 * tokens semânticos do design system (já tema/marca-aware via CSS var). */
const NIVEL_BORDER: Record<string, string> = {
  Vermelho: "var(--color-error)",
  Amarelo: "var(--color-warning)",
  Verde: "var(--color-success)",
};

interface KanbanCardProps {
  lead: Lead;
  index: number;
  pipelineId: string;
  isSelected?: boolean;
  onSelect?: (leadId: string, additive: boolean) => void;
}

function formatBRL(cents: number | null, currency: string | null): string | null {
  if (cents == null) return null;
  const code = currency ?? "BRL";
  try {
    return new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: code,
      maximumFractionDigits: 0,
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${code}`;
  }
}

function ownerInitials(ownerId: string | null): string {
  if (!ownerId) return "—";
  return ownerId.slice(0, 2).toUpperCase();
}

export function KanbanCard({
  lead,
  index,
  pipelineId,
  isSelected,
  onSelect,
}: KanbanCardProps) {
  const value = formatBRL(lead.value_cents, lead.currency);
  const contactName = lead.contact?.display_name?.trim() || lead.contact?.name?.trim() || null;
  const contactPhone = lead.contact?.phone_number ?? null;

  // Potencial do cliente (base de vendas): nº de unidades adquiridas + valor total.
  const cf = lead.custom_fields ?? {};
  const unidadesNum = Number(cf["unidades_cliente"]);
  const unidadesCliente = Number.isFinite(unidadesNum) && unidadesNum > 0 ? unidadesNum : null;
  const valorVendaRaw = cf["valor_venda"];
  const valorVenda =
    typeof valorVendaRaw === "string" && valorVendaRaw.trim() ? valorVendaRaw.trim() : null;
  // Categoria do chamado (Jurídico/Financeiro/Obra…) — mostrada ao lado do nº.
  const categoriaRaw = cf["categoria"];
  const categoria =
    typeof categoriaRaw === "string" && categoriaRaw.trim() ? categoriaRaw.trim() : null;
  // Nível de acompanhamento (Verde/Amarelo/Vermelho) — vira cor na borda inferior.
  const nivelRaw = cf["nivel_acompanhamento"];
  const nivelBorder = typeof nivelRaw === "string" ? NIVEL_BORDER[nivelRaw] : undefined;
  // Evita repetir o nome quando o título do lead já começa com ele.
  const showContactName =
    contactName != null && !lead.title.toLowerCase().startsWith(contactName.toLowerCase());

  const handleClick = (e: MouseEvent<HTMLDivElement>) => {
    if (!onSelect) return;
    const additive = e.metaKey || e.ctrlKey;
    onSelect(lead.id, additive);
  };

  return (
    <Draggable draggableId={lead.id} index={index}>
      {(provided, snapshot) => (
        <div
          ref={provided.innerRef}
          {...provided.draggableProps}
          {...provided.dragHandleProps}
          onClick={handleClick}
          style={nivelBorder ? { borderBottomColor: nivelBorder, borderBottomWidth: 3 } : undefined}
          className={cn(
            "group rounded-md border border-border bg-surface p-3 shadow-xs transition-colors",
            "hover:border-border-strong",
            snapshot.isDragging && "rotate-1 shadow-md ring-1 ring-accent/40",
            isSelected && "ring-2 ring-accent",
          )}
        >
          {(lead.external_id || categoria) && (
            <div className="mb-1 flex items-baseline gap-2">
              <span className="flex-1 truncate text-[10px] font-medium uppercase tracking-wide tabular-nums text-text-muted">
                {lead.external_id}
              </span>
              {categoria && (
                <span
                  className="max-w-[50%] shrink-0 truncate text-[10px] font-medium text-text-muted"
                  title={categoria}
                >
                  {categoria}
                </span>
              )}
            </div>
          )}
          <div className="flex items-start justify-between gap-2">
            <h3 className="line-clamp-2 text-sm font-medium leading-snug text-text">
              {lead.title}
            </h3>
            <KanbanCardActions lead={lead} pipelineId={pipelineId} />
          </div>

          {(showContactName || contactPhone) && (
            <p className="mt-1 truncate text-xs text-text-muted">
              {showContactName ? contactName : null}
              {showContactName && contactPhone ? " · " : null}
              {contactPhone ? <span className="tabular-nums">{contactPhone}</span> : null}
            </p>
          )}

          {(unidadesCliente || valorVenda) && (
            <p className="mt-1.5 flex items-center gap-1 truncate text-[11px] font-medium tabular-nums text-text-muted">
              {unidadesCliente && (
                <span className="inline-flex shrink-0 items-center gap-0.5" title={`${unidadesCliente} unidade${unidadesCliente > 1 ? "s" : ""} adquirida${unidadesCliente > 1 ? "s" : ""}`}>
                  <House size={12} weight="fill" aria-hidden />
                  {unidadesCliente}
                </span>
              )}
              {unidadesCliente && valorVenda ? <span aria-hidden>·</span> : null}
              {valorVenda ? <span className="truncate">{valorVenda}</span> : null}
            </p>
          )}

          {value && (
            <p className="mt-2 text-xs font-medium tabular-nums text-text-muted">
              {value}
            </p>
          )}

          {lead.tags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {lead.tags.slice(0, 3).map((tag) => (
                <Badge key={tag} variant="secondary" className="text-[10px]">
                  {tag}
                </Badge>
              ))}
              {lead.tags.length > 3 && (
                <span className="text-[10px] text-text-muted">
                  +{lead.tags.length - 3}
                </span>
              )}
            </div>
          )}

          <div className="mt-3 flex items-center justify-between">
            <div
              aria-label={lead.owner_user_id ? `Dono ${lead.owner_user_id}` : "Sem dono"}
              className="flex h-6 w-6 items-center justify-center rounded-full bg-surface-muted text-[10px] font-medium text-text-muted"
            >
              {ownerInitials(lead.owner_user_id)}
            </div>
          </div>
        </div>
      )}
    </Draggable>
  );
}
