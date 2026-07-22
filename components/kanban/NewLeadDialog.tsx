"use client";
import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
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
  type CustomFieldDef,
} from "@/components/contacts/CustomFieldsEditor";
import { ContactPicker, type ContactDisplay } from "@/components/kanban/ContactPicker";
import { BuyerLookup, type BuyerAggregate } from "@/components/kanban/BuyerLookup";
import { useCreateLead } from "@/hooks/kanban/useCreateLead";
import { useCreateContact } from "@/hooks/contacts/useCreateContact";
import type { Sale } from "@/hooks/sales/useSalesBase";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { Contact } from "@/lib/types/contacts";
import type { ContactCreate } from "@/lib/schemas/contacts";
import type { Stage } from "@/lib/kanban/types";
import { createLeadSchema, type CreateLeadInput } from "@/lib/schemas/leads";

function formatBRL(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface FormShape {
  title: string;
  description: string;
  stage_id: string;
  valueReais: string;
  tagsRaw: string;
  expected_close_date: string;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  pipelineId: string;
  stages: Stage[];
  /** Campos customizados declarados em pipeline.settings.fields. Vazio ⇒ some. */
  fields?: CustomFieldDef[];
  /** Vocabulário do pipeline (ex.: "Chamado"). Default "Lead". */
  leadNoun?: string;
  /** Campos embutidos escondidos via settings.form_hide ("value", "expected_close_date", "tags"). */
  hiddenFields?: Set<string>;
}

function defaultStageId(stages: Stage[]): string {
  const open = stages.find((s) => !s.is_won && !s.is_lost && !s.is_archived);
  return open?.id ?? stages[0]?.id ?? "";
}

export function NewLeadDialog({
  open,
  onOpenChange,
  pipelineId,
  stages,
  fields = [],
  leadNoun = "Lead",
  hiddenFields,
}: Props) {
  const nounLower = leadNoun.toLowerCase();
  const hide = (k: string) => hiddenFields?.has(k) ?? false;
  // Criação enxuta: campos de acompanhamento (hideOnCreate) só aparecem na edição.
  const createFields = useMemo(() => fields.filter((f) => !f.hideOnCreate), [fields]);
  const create = useCreateLead(pipelineId);
  const createContact = useCreateContact();
  const initialStage = useMemo(() => defaultStageId(stages), [stages]);
  const [customValues, setCustomValues] = useState<Record<string, unknown>>({});
  const [contactId, setContactId] = useState<string | null>(null);
  const [pickedContact, setPickedContact] = useState<ContactDisplay | null>(null);
  // A busca do comprador só existe em pipelines que usam este fluxo (têm empreendimento).
  const buyerLookupEnabled = useMemo(
    () => createFields.some((f) => f.key === "empreendimento"),
    [createFields],
  );

  /** Acha o contato pelo telefone (E.164) ou cria um novo com os dados da venda. */
  async function findOrCreateContact(sale: Sale): Promise<Contact | null> {
    const phone = sale.phone_e164?.trim() || null;
    if (phone) {
      const digits = phone.replace(/\D/g, "");
      const res = await apiClient.get<{ data: Contact[] }>(
        `/api/v1/contacts?search=${encodeURIComponent(digits)}&limit=50`,
      );
      const match = res.data.find((c) => (c.phone_number ?? "").replace(/\D/g, "") === digits);
      if (match) return match;
    }
    const payload: ContactCreate = { source: "manual" };
    if (sale.cliente) payload.name = sale.cliente;
    if (phone) payload.phone_number = phone;
    if (sale.email && EMAIL_RE.test(sale.email.trim())) payload.email = sale.email.trim();
    if (!payload.name && !payload.phone_number) return null;
    // O POST devolve { data: { contact, action } }; normaliza p/ o Contact.
    const created = await createContact.mutateAsync(payload);
    const d = created.data as unknown as ({ contact?: Contact } & Partial<Contact>);
    return d.contact ?? (d as Contact) ?? null;
  }

  /** Auto-preenche o formulário a partir de uma venda escolhida na base. */
  async function onSelectBuyer(sale: Sale, agg: BuyerAggregate) {
    const cf: Record<string, unknown> = {};
    if (sale.empreendimento) cf.empreendimento = sale.empreendimento;
    if (sale.unidade) cf.unidade = sale.unidade;
    if (sale.profissao) cf.profissao = sale.profissao;
    if (sale.imobiliaria) cf.imobiliaria = sale.imobiliaria;
    // valor_venda = SOMA de todas as unidades do cliente; unidades_cliente = quantas (mostrado no card).
    if (agg.totalCents > 0) cf.valor_venda = formatBRL(agg.totalCents);
    if (agg.units > 0) cf.unidades_cliente = agg.units;
    setCustomValues((prev) => ({ ...prev, ...cf }));

    const local = [sale.empreendimento, sale.unidade].filter(Boolean).join(" ");
    const title = [sale.cliente, local].filter(Boolean).join(" — ");
    if (title.length >= 2) form.setValue("title", title);

    if (!sale.cliente && !sale.phone_e164) return;
    try {
      const contact = await findOrCreateContact(sale);
      if (contact?.id) {
        setContactId(contact.id);
        setPickedContact({
          display_name: contact.display_name ?? null,
          name: contact.name ?? null,
          phone_number: contact.phone_number ?? null,
        });
      }
    } catch (err) {
      showApiError(err);
    }
  }

  const form = useForm<FormShape>({
    defaultValues: {
      title: "",
      description: "",
      stage_id: initialStage,
      valueReais: "",
      tagsRaw: "",
      expected_close_date: "",
    },
  });

  // Reset stage_id default if stages change while dialog mounted.
  useEffect(() => {
    if (!form.getValues("stage_id") && initialStage) {
      form.setValue("stage_id", initialStage);
    }
  }, [initialStage, form]);

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

    const payload: Record<string, unknown> = {
      pipeline_id: pipelineId,
      stage_id: values.stage_id,
      title: values.title.trim(),
      currency: "BRL",
      source: "manual",
      tags,
    };
    if (values.description.trim()) payload.description = values.description.trim();
    if (contactId) payload.contact_id = contactId;
    if (valueCents !== null) payload.value_cents = valueCents;
    if (values.expected_close_date) payload.expected_close_date = values.expected_close_date;
    if (createFields.length > 0) payload.custom_fields = buildCustomFields(createFields, customValues);

    const parsed = createLeadSchema.safeParse(payload);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      toast.error(first?.message ?? "Dados inválidos");
      return;
    }

    try {
      await create.mutateAsync(parsed.data as CreateLeadInput);
      toast.success(`${leadNoun} criado`);
      form.reset({
        title: "",
        description: "",
        stage_id: initialStage,
        valueReais: "",
        tagsRaw: "",
        expected_close_date: "",
      });
      setCustomValues({});
      setContactId(null);
      setPickedContact(null);
      onOpenChange(false);
    } catch {
      // toast already shown
    }
  }

  const stageId = form.watch("stage_id");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle>Novo {leadNoun}</DialogTitle>
          <DialogDescription>
            Crie um {nounLower} manualmente neste pipeline.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-1 py-1">
          <BuyerLookup
            enabled={buyerLookupEnabled}
            onSelect={onSelectBuyer}
            disabled={create.isPending}
          />

          {/* Divisor que separa a busca (acima) do preenchimento do chamado. */}
          {buyerLookupEnabled && (
            <div className="flex items-center gap-3 pt-1" aria-hidden>
              <span className="h-px flex-1 bg-border" />
              <span className="text-[11px] font-medium uppercase tracking-wide text-text-muted">
                ou preencha manualmente
              </span>
              <span className="h-px flex-1 bg-border" />
            </div>
          )}

          <div className="space-y-2">
            <Label>Etapa</Label>
            <Select
              value={stageId}
              onValueChange={(v) => form.setValue("stage_id", v)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Selecione a etapa" />
              </SelectTrigger>
              <SelectContent>
                {stages
                  .filter((s) => !s.is_archived)
                  .map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="title">Título</Label>
            <Input
              id="title"
              placeholder={`Resumo do ${nounLower}`}
              {...form.register("title", { required: true, minLength: 2 })}
            />
          </div>

          <ContactPicker
            value={contactId}
            onChange={(id) => {
              setContactId(id);
              if (!id) setPickedContact(null);
            }}
            initialContact={pickedContact}
            disabled={create.isPending}
          />

          {createFields.length > 0 && (
            <CustomFieldsEditor
              fields={createFields}
              value={customValues}
              onChange={setCustomValues}
              mode="lead"
              disabled={create.isPending}
            />
          )}

          <div className="space-y-2">
            <Label htmlFor="description">Descrição</Label>
            <Textarea
              id="description"
              rows={3}
              placeholder="Contexto, observações, links…"
              {...form.register("description")}
            />
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
              <Input
                id="tagsRaw"
                placeholder="vip, recompra"
                {...form.register("tagsRaw")}
              />
            </div>
          )}
          </div>

          <DialogFooter className="shrink-0 border-t pt-4">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={create.isPending}
            >
              Cancelar
            </Button>
            <Button type="submit" disabled={create.isPending || !stageId}>
              {create.isPending ? "Criando…" : `Criar ${nounLower}`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
