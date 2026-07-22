"use client";
import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CustomFieldsEditor,
  buildCustomFields,
  readCustomFields,
  readHiddenFormFields,
  type CustomFieldDef,
} from "@/components/contacts/CustomFieldsEditor";
import { ContactPicker } from "@/components/kanban/ContactPicker";
import { useEditLead } from "@/hooks/kanban/useUpdateLead";
import { useMoveCard } from "@/hooks/kanban/useMoveCard";
import type { Lead } from "@/lib/types/leads";
import type { BoardData } from "@/lib/kanban/types";
import { updateLeadSchema, type UpdateLeadInput } from "@/lib/schemas/leads";

interface FormShape {
  title: string;
  description: string;
  valueReais: string;
  tagsRaw: string;
  expected_close_date: string;
}

interface LinkedProductRow {
  id: string;
  relation: string;
  note: string | null;
  product: {
    id: string;
    title: string;
    price_cents: number | null;
    currency: string | null;
    location: string | null;
    url: string | null;
    kind: string | null;
  } | null;
}

const RELATION_LABEL: Record<string, string> = {
  interest: "Interesse",
  proposal: "Proposta",
  visit: "Visita",
  discarded: "Descartado",
};

function formatMoney(cents: number | null, currency: string | null): string {
  if (cents == null) return "—";
  try {
    return new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: currency ?? "BRL",
      maximumFractionDigits: 0,
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency ?? "BRL"}`;
  }
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  lead: Lead;
  pipelineId: string;
}

function centsToReais(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "";
  return (cents / 100).toFixed(2).replace(".", ",");
}

export function EditLeadDialog({ open, onOpenChange, lead, pipelineId }: Props) {
  const edit = useEditLead(pipelineId);
  const move = useMoveCard(pipelineId);
  const qc = useQueryClient();
  const [linked, setLinked] = useState<LinkedProductRow[] | null>(null);

  // Campos customizados declarados em pipeline.settings.fields. Lidos do cache
  // do board (já carregado por PipelinePageClient em ["board", pipelineId]) —
  // sem prop-drilling nem fetch extra. Vazio ⇒ a seção some (retrocompatível).
  const board = qc.getQueryData<BoardData>(["board", pipelineId]);
  const boardPipeline = board?.pipeline;
  const settings = boardPipeline?.settings;
  const leadNoun = boardPipeline?.vocabulary?.lead ?? "Lead";
  const wonWord = boardPipeline?.vocabulary?.won ?? "ganho";
  const lostWord = boardPipeline?.vocabulary?.lost ?? "perdido";
  const stages = useMemo(() => board?.stages ?? [], [board]);
  const hiddenFields = useMemo(() => readHiddenFormFields(settings), [settings]);
  const hide = (k: string) => hiddenFields.has(k);
  const fields = useMemo<CustomFieldDef[]>(() => readCustomFields(settings), [settings]);
  const [customValues, setCustomValues] = useState<Record<string, unknown>>({});
  const [contactId, setContactId] = useState<string | null>(lead.contact_id);
  // Etapa controlada localmente pra refletir a troca na hora (o move é otimista).
  const [stageId, setStageId] = useState<string>(lead.stage_id);

  /**
   * Troca a etapa direto no diálogo (além do arraste no board). Usa o endpoint
   * /move (a etapa NÃO vai no PATCH — ver updateLeadSchema). Ganho/perdido têm
   * ações próprias no card, então ficam desabilitados aqui.
   */
  function moveToStage(nextStageId: string) {
    if (nextStageId === stageId) return;
    setStageId(nextStageId);
    const inStage = (board?.leads ?? []).filter(
      (l) => l.stage_id === nextStageId && l.id !== lead.id,
    );
    const maxPos = inStage.reduce((m, l) => Math.max(m, l.position_in_stage), 0);
    move.mutate({
      leadId: lead.id,
      stageId: nextStageId,
      positionInStage: maxPos + 1000,
      expectedUpdatedAt: lead.updated_at,
    });
  }

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch(`/api/v1/leads/${lead.id}/products`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((json: { data: { products: LinkedProductRow[] } }) => {
        if (!cancelled) setLinked(json.data.products ?? []);
      })
      .catch(() => {
        if (!cancelled) setLinked([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, lead.id]);

  const form = useForm<FormShape>({
    defaultValues: {
      title: lead.title,
      description: lead.description ?? "",
      valueReais: centsToReais(lead.value_cents),
      tagsRaw: (lead.tags ?? []).join(", "),
      expected_close_date: lead.expected_close_date ?? "",
    },
  });

  useEffect(() => {
    if (open) {
      form.reset({
        title: lead.title,
        description: lead.description ?? "",
        valueReais: centsToReais(lead.value_cents),
        tagsRaw: (lead.tags ?? []).join(", "),
        expected_close_date: lead.expected_close_date ?? "",
      });
      // Pré-preenche os campos customizados com os valores atuais do lead.
      setCustomValues((lead.custom_fields ?? {}) as Record<string, unknown>);
      setContactId(lead.contact_id);
      setStageId(lead.stage_id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, lead.id]);

  async function onSubmit(values: FormShape) {
    const tags = values.tagsRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const reais = values.valueReais.trim();
    let valueCents: number | null = null;
    if (reais.length > 0) {
      const normalized = reais.replace(/\./g, "").replace(",", ".");
      const n = Number(normalized);
      if (!Number.isFinite(n) || n < 0) {
        form.setError("valueReais", { message: "Valor inválido" });
        return;
      }
      valueCents = Math.round(n * 100);
    }

    const patch: Record<string, unknown> = {
      title: values.title.trim(),
      description: values.description.trim() ? values.description.trim() : null,
      value_cents: valueCents,
      tags,
      expected_close_date: values.expected_close_date || null,
      contact_id: contactId,
    };
    // O handler faz merge (não replace), preservando chaves gravadas pela IA.
    if (fields.length > 0) patch.custom_fields = buildCustomFields(fields, customValues);

    const parsed = updateLeadSchema.safeParse(patch);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      toast.error(first?.message ?? "Dados inválidos");
      return;
    }

    try {
      await edit.mutateAsync({
        leadId: lead.id,
        patch: parsed.data as UpdateLeadInput,
      });
      toast.success(`${leadNoun} atualizado`);
      onOpenChange(false);
    } catch {
      // toast already shown
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle>
            {lead.external_id
              ? `${leadNoun} ${lead.external_id}`
              : `Editar ${leadNoun.toLowerCase()}`}
          </DialogTitle>
          <DialogDescription>
            Atualize os campos. Marcar {wonWord.toLowerCase()}/{lostWord.toLowerCase()} tem
            ações próprias no card.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-1 py-1">
          {stages.length > 0 && (
            <div className="space-y-2">
              <Label>Etapa</Label>
              <Select value={stageId} onValueChange={moveToStage} disabled={move.isPending}>
                <SelectTrigger>
                  <SelectValue placeholder="Selecione a etapa" />
                </SelectTrigger>
                <SelectContent>
                  {stages
                    .filter((s) => !s.is_archived)
                    .map((s) => (
                      <SelectItem key={s.id} value={s.id} disabled={s.is_won || s.is_lost}>
                        {s.name}
                        {s.is_won ? ` (use "Marcar como ${wonWord.toLowerCase()}")` : ""}
                        {s.is_lost ? ` (use "Marcar como ${lostWord.toLowerCase()}")` : ""}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="title">Título</Label>
            <Input
              id="title"
              {...form.register("title", { required: true, minLength: 2 })}
            />
          </div>

          <ContactPicker
            value={contactId}
            onChange={(id) => setContactId(id)}
            initialContact={lead.contact ?? null}
            disabled={edit.isPending}
          />

          {fields.length > 0 && (
            <CustomFieldsEditor
              fields={fields}
              value={customValues}
              onChange={setCustomValues}
              mode="lead"
              disabled={edit.isPending}
            />
          )}

          <div className="space-y-2">
            <Label htmlFor="description">Descrição</Label>
            <Textarea id="description" rows={3} {...form.register("description")} />
          </div>

          {(!hide("value") || !hide("expected_close_date")) && (
            <div className="grid grid-cols-2 gap-3">
              {!hide("value") && (
                <div className="space-y-2">
                  <Label htmlFor="valueReais">Valor (R$)</Label>
                  <Input
                    id="valueReais"
                    inputMode="decimal"
                    placeholder="0,00"
                    {...form.register("valueReais")}
                  />
                  {form.formState.errors.valueReais && (
                    <p className="text-xs text-error-fg">
                      {form.formState.errors.valueReais.message}
                    </p>
                  )}
                </div>
              )}
              {!hide("expected_close_date") && (
                <div className="space-y-2">
                  <Label htmlFor="expected_close_date">Fechamento previsto</Label>
                  <Input
                    id="expected_close_date"
                    type="date"
                    {...form.register("expected_close_date")}
                  />
                </div>
              )}
            </div>
          )}

          {!hide("tags") && (
            <div className="space-y-2">
              <Label htmlFor="tagsRaw">Tags (separadas por vírgula)</Label>
              <Input id="tagsRaw" placeholder="vip, recompra" {...form.register("tagsRaw")} />
            </div>
          )}

          {linked && linked.length > 0 && (
            <div className="space-y-2">
              <Label>
                {linked.every((lp) => (lp.product?.kind ?? "imovel") === "imovel")
                  ? "Imóveis de interesse"
                  : "Produtos de interesse"}
              </Label>
              <ul className="max-h-40 space-y-1.5 overflow-y-auto">
                {linked.map((lp) => {
                  if (!lp.product) return null;
                  const p = lp.product;
                  return (
                    <li
                      key={lp.id}
                      className="flex items-start justify-between gap-2 rounded-md border border-border p-2 text-xs"
                    >
                      <div className="min-w-0">
                        <div className="truncate font-medium">
                          {p.url ? (
                            <a
                              href={p.url}
                              target="_blank"
                              rel="noreferrer"
                              className="hover:underline"
                            >
                              {p.title}
                            </a>
                          ) : (
                            p.title
                          )}
                        </div>
                        <div className="text-muted-foreground">
                          {p.location ? `${p.location} · ` : ""}
                          {formatMoney(p.price_cents, p.currency)}
                        </div>
                        {lp.note && <div className="text-muted-foreground">{lp.note}</div>}
                      </div>
                      <Badge variant="secondary" className="h-4 shrink-0 px-1.5 text-[10px]">
                        {RELATION_LABEL[lp.relation] ?? lp.relation}
                      </Badge>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          </div>

          <DialogFooter className="shrink-0 border-t pt-4">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={edit.isPending}
            >
              Cancelar
            </Button>
            <Button type="submit" disabled={edit.isPending}>
              {edit.isPending ? "Salvando…" : "Salvar"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
