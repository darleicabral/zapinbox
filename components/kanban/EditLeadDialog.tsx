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
  CustomFieldsEditor,
  buildCustomFields,
  readCustomFields,
  type CustomFieldDef,
} from "@/components/contacts/CustomFieldsEditor";
import { ContactPicker } from "@/components/kanban/ContactPicker";
import { useEditLead } from "@/hooks/kanban/useUpdateLead";
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
  const qc = useQueryClient();
  const [linked, setLinked] = useState<LinkedProductRow[] | null>(null);

  // Campos customizados declarados em pipeline.settings.fields. Lidos do cache
  // do board (já carregado por PipelinePageClient em ["board", pipelineId]) —
  // sem prop-drilling nem fetch extra. Vazio ⇒ a seção some (retrocompatível).
  const settings = qc.getQueryData<BoardData>(["board", pipelineId])?.pipeline.settings;
  const fields = useMemo<CustomFieldDef[]>(() => readCustomFields(settings), [settings]);
  const [customValues, setCustomValues] = useState<Record<string, unknown>>({});
  const [contactId, setContactId] = useState<string | null>(lead.contact_id);

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
      toast.success("Lead atualizado");
      onOpenChange(false);
    } catch {
      // toast already shown
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {lead.external_id ? `Chamado ${lead.external_id}` : "Editar lead"}
          </DialogTitle>
          <DialogDescription>
            Atualize os campos. Mover de etapa ou marcar ganho/perdido tem opções
            próprias.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="title">Título</Label>
            <Input
              id="title"
              {...form.register("title", { required: true, minLength: 2 })}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">Descrição</Label>
            <Textarea id="description" rows={3} {...form.register("description")} />
          </div>

          <div className="grid grid-cols-2 gap-3">
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
            <div className="space-y-2">
              <Label htmlFor="expected_close_date">Fechamento previsto</Label>
              <Input
                id="expected_close_date"
                type="date"
                {...form.register("expected_close_date")}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="tagsRaw">Tags (separadas por vírgula)</Label>
            <Input id="tagsRaw" placeholder="vip, recompra" {...form.register("tagsRaw")} />
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

          <DialogFooter>
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
