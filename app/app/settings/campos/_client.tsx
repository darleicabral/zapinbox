"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Plus, X, Info } from "@/lib/ui/icons";
import { updatePipelineConfig } from "@/app/actions/settings/updatePipelineConfig";
import type { CustomFieldDef } from "@/components/contacts/CustomFieldsEditor";
import type { PipelineConfigPatch } from "@/lib/schemas/settings";
import { cn } from "@/lib/utils";

type Opt = { value: string; label: string };

/**
 * Selects cujas opções são acopladas a código/lógica — NÃO editáveis aqui, p/
 * não quebrar nada. Todo o resto dos selects vira editável automaticamente.
 */
const LOCKED_SELECTS = new Set([
  "nivel_acompanhamento", // vira a cor do card (Verde/Amarelo/Vermelho)
  "empreendimento", // "Van Gogh" dispara o bloco condicional VG
  "titular_exterior", // Sim/Não
  "vg_contrapartida", // Sim/Não
  "vg_material_enviado", // Sim/Não
]);

export function FieldOptionsClient({
  pipelineId,
  initialFields,
}: {
  pipelineId: string;
  initialFields: CustomFieldDef[];
}) {
  const [fields, setFields] = useState<CustomFieldDef[]>(initialFields);
  const [dirty, setDirty] = useState(false);
  const [isPending, startTransition] = useTransition();

  const editable = fields.filter((f) => f.type === "select" && !LOCKED_SELECTS.has(f.key));

  function labelOf(key: string): string {
    return fields.find((f) => f.key === key)?.label ?? key;
  }

  /** Adiciona opção a um select simples. Se o campo for pai de um dependente
   *  (ex.: categoria → subcategoria), cria o balde vazio da nova opção. */
  function addOption(fieldKey: string, raw: string) {
    const label = raw.trim();
    if (!label) return;
    const field = fields.find((f) => f.key === fieldKey);
    if ((field?.options ?? []).some((o) => o.value === label || o.label === label)) {
      toast.error("Essa opção já existe.");
      return;
    }
    setFields((prev) =>
      prev.map((f) => {
        if (f.key === fieldKey) {
          return { ...f, options: [...(f.options ?? []), { value: label, label }] };
        }
        if (f.optionsBy?.field === fieldKey && !(label in f.optionsBy.map)) {
          return { ...f, optionsBy: { ...f.optionsBy, map: { ...f.optionsBy.map, [label]: [] } } };
        }
        return f;
      }),
    );
    setDirty(true);
  }

  function removeOption(fieldKey: string, value: string) {
    setFields((prev) =>
      prev.map((f) => {
        if (f.key === fieldKey) {
          return { ...f, options: (f.options ?? []).filter((o) => o.value !== value) };
        }
        if (f.optionsBy?.field === fieldKey && value in f.optionsBy.map) {
          const nextMap = { ...f.optionsBy.map };
          delete nextMap[value];
          return { ...f, optionsBy: { ...f.optionsBy, map: nextMap } };
        }
        return f;
      }),
    );
    setDirty(true);
  }

  function addDepOption(fieldKey: string, parentValue: string, raw: string) {
    const label = raw.trim();
    if (!label) return;
    const field = fields.find((f) => f.key === fieldKey);
    const bucket = field?.optionsBy?.map[parentValue] ?? [];
    if (bucket.some((o) => o.value === label || o.label === label)) {
      toast.error("Essa opção já existe.");
      return;
    }
    setFields((prev) =>
      prev.map((f) => {
        if (f.key !== fieldKey || !f.optionsBy) return f;
        const cur = f.optionsBy.map[parentValue] ?? [];
        return {
          ...f,
          optionsBy: {
            ...f.optionsBy,
            map: { ...f.optionsBy.map, [parentValue]: [...cur, { value: label, label }] },
          },
        };
      }),
    );
    setDirty(true);
  }

  function removeDepOption(fieldKey: string, parentValue: string, value: string) {
    setFields((prev) =>
      prev.map((f) => {
        if (f.key !== fieldKey || !f.optionsBy) return f;
        const cur = f.optionsBy.map[parentValue] ?? [];
        return {
          ...f,
          optionsBy: {
            ...f.optionsBy,
            map: { ...f.optionsBy.map, [parentValue]: cur.filter((o) => o.value !== value) },
          },
        };
      }),
    );
    setDirty(true);
  }

  function handleSave() {
    const patch: PipelineConfigPatch = { fields: fields as PipelineConfigPatch["fields"] };
    startTransition(async () => {
      const r = await updatePipelineConfig(pipelineId, patch);
      if (r.ok) {
        toast.success("Opções salvas.");
        setDirty(false);
      } else {
        toast.error(`Erro ao salvar: ${r.error}`);
      }
    });
  }

  if (editable.length === 0) {
    return (
      <Card className="p-6 text-sm text-muted-foreground">
        Este pipeline não tem campos de seleção editáveis.
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {editable.map((f) =>
        f.optionsBy ? (
          <DependentFieldCard
            key={f.key}
            field={f}
            parentLabel={labelOf(f.optionsBy.field)}
            parentOptions={fields.find((pf) => pf.key === f.optionsBy!.field)?.options ?? []}
            onAdd={(parentValue, raw) => addDepOption(f.key, parentValue, raw)}
            onRemove={(parentValue, value) => removeDepOption(f.key, parentValue, value)}
          />
        ) : (
          <SimpleFieldCard
            key={f.key}
            field={f}
            feedsInto={fields.find((df) => df.optionsBy?.field === f.key)?.label ?? null}
            onAdd={(raw) => addOption(f.key, raw)}
            onRemove={(value) => removeOption(f.key, value)}
          />
        ),
      )}

      <div className="sticky bottom-0 -mx-1 flex items-center justify-end gap-3 border-t border-border bg-bg/80 px-1 py-3 backdrop-blur">
        {dirty && (
          <span className="text-xs text-warning-fg">Alterações não salvas</span>
        )}
        <Button onClick={handleSave} disabled={isPending || !dirty}>
          {isPending ? "Salvando…" : "Salvar alterações"}
        </Button>
      </div>
    </div>
  );
}

function SimpleFieldCard({
  field,
  feedsInto,
  onAdd,
  onRemove,
}: {
  field: CustomFieldDef;
  feedsInto: string | null;
  onAdd: (raw: string) => void;
  onRemove: (value: string) => void;
}) {
  const options = field.options ?? [];
  return (
    <Card className="space-y-3 p-5">
      <div>
        <h2 className="text-sm font-semibold">{field.label}</h2>
        {feedsInto && (
          <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
            <Info size={13} aria-hidden />
            Cada opção tem suas próprias {feedsInto.toLowerCase()} no bloco abaixo.
          </p>
        )}
      </div>

      <OptionChips options={options} onRemove={onRemove} emptyLabel="Nenhuma opção ainda." />
      <AddOption onAdd={onAdd} placeholder={`Nova opção de ${field.label.toLowerCase()}…`} />
    </Card>
  );
}

function DependentFieldCard({
  field,
  parentLabel,
  parentOptions,
  onAdd,
  onRemove,
}: {
  field: CustomFieldDef;
  parentLabel: string;
  parentOptions: Opt[];
  onAdd: (parentValue: string, raw: string) => void;
  onRemove: (parentValue: string, value: string) => void;
}) {
  const map = field.optionsBy?.map ?? {};
  return (
    <Card className="space-y-4 p-5">
      <div>
        <h2 className="text-sm font-semibold">{field.label}</h2>
        <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
          <Info size={13} aria-hidden />
          As opções mudam conforme {parentLabel.toLowerCase()}.
        </p>
      </div>

      {parentOptions.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Cadastre {parentLabel.toLowerCase()} primeiro.
        </p>
      ) : (
        <div className="space-y-3">
          {parentOptions.map((parent) => (
            <div
              key={parent.value}
              className="space-y-2 rounded-lg border border-border bg-surface-muted/60 p-3"
            >
              <div className="text-xs font-semibold uppercase tracking-wide text-text-muted">
                {parent.label}
              </div>
              <OptionChips
                options={map[parent.value] ?? []}
                onRemove={(value) => onRemove(parent.value, value)}
                emptyLabel="Sem subopções."
              />
              <AddOption
                onAdd={(raw) => onAdd(parent.value, raw)}
                placeholder={`Nova opção em ${parent.label.toLowerCase()}…`}
              />
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function OptionChips({
  options,
  onRemove,
  emptyLabel,
}: {
  options: Opt[];
  onRemove: (value: string) => void;
  emptyLabel: string;
}) {
  if (options.length === 0) {
    return <p className="text-xs text-text-subtle">{emptyLabel}</p>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <span
          key={o.value}
          className="inline-flex items-center gap-1 rounded-full border border-border bg-surface py-1 pl-3 pr-1.5 text-sm"
        >
          {o.label}
          <button
            type="button"
            onClick={() => onRemove(o.value)}
            aria-label={`Remover ${o.label}`}
            className={cn(
              "flex h-4 w-4 items-center justify-center rounded-full text-text-subtle",
              "transition-colors duration-fast ease-out hover:bg-error-bg hover:text-error-fg",
            )}
          >
            <X size={11} weight="bold" aria-hidden />
          </button>
        </span>
      ))}
    </div>
  );
}

function AddOption({
  onAdd,
  placeholder,
}: {
  onAdd: (raw: string) => void;
  placeholder: string;
}) {
  const [text, setText] = useState("");
  function commit() {
    const v = text.trim();
    if (!v) return;
    onAdd(v);
    setText("");
  }
  return (
    <div className="flex items-center gap-2">
      <Input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
        placeholder={placeholder}
        className="h-9"
      />
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={commit}
        disabled={!text.trim()}
        className="shrink-0"
      >
        <Plus size={15} className="mr-1" aria-hidden />
        Adicionar
      </Button>
    </div>
  );
}
