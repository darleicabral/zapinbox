"use client";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useContactList } from "@/hooks/contacts/useContactList";
import { useCreateContact } from "@/hooks/contacts/useCreateContact";
import { contactCreateSchema, type ContactCreate } from "@/lib/schemas/contacts";
import type { Contact } from "@/lib/types/contacts";

type LabelSource = {
  display_name?: string | null;
  name?: string | null;
  phone_number?: string | null;
  email?: string | null;
};

export function contactLabel(c: LabelSource): string {
  return c.display_name || c.name || c.phone_number || c.email || "Sem nome";
}

/** Exibição mínima de um contato já vinculado (embed do lead, sem id/email). */
export type ContactDisplay = {
  display_name: string | null;
  name: string | null;
  phone_number: string | null;
};

interface Props {
  /** contact_id selecionado (ou null). */
  value: string | null;
  /** Chamado com o novo contact_id (null p/ desvincular). O contato completo vem quando conhecido. */
  onChange: (contactId: string | null, contact?: Contact) => void;
  /** Exibição do contato já vinculado (p/ o Edit), até que a busca o carregue. */
  initialContact?: ContactDisplay | null;
  disabled?: boolean;
}

/**
 * Seletor de contato para vincular a um chamado/lead. Inline (não Popover) porque
 * vive dentro de um Dialog Radix — Popover aninhado briga com o focus-trap.
 * Busca por nome/telefone/email (mesma API dos contatos) ou cria um novo na hora.
 */
export function ContactPicker({ value, onChange, initialContact, disabled = false }: Props) {
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<Contact | null>(null);

  // Debounce da busca (evita bater na API a cada tecla).
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const list = useContactList({ search: debounced || undefined });
  const results = useMemo<Contact[]>(
    () => list.data?.pages.flatMap((p) => p.data) ?? [],
    [list.data],
  );

  // Se há value mas não conhecemos o contato ainda, tenta achá-lo nos resultados.
  useEffect(() => {
    if (value && (!selected || selected.id !== value)) {
      const found = results.find((c) => c.id === value);
      if (found) setSelected(found);
    }
    if (!value && selected) setSelected(null);
  }, [value, results, selected]);

  function pick(c: Contact) {
    setSelected(c);
    onChange(c.id, c);
    setSearch("");
    setDebounced("");
  }

  function clear() {
    setSelected(null);
    onChange(null);
  }

  // ── Contato já vinculado ─────────────────────────────────────────────
  if (value && selected) {
    return (
      <div className="space-y-2">
        <Label>Cliente vinculado</Label>
        <div className="flex items-center justify-between rounded-md border px-3 py-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{contactLabel(selected)}</p>
            {selected.phone_number && (
              <p className="truncate text-xs text-muted-foreground">{selected.phone_number}</p>
            )}
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={clear} disabled={disabled}>
            Trocar
          </Button>
        </div>
      </div>
    );
  }

  // ── Vinculado por id mas Contact completo ainda não carregado ───────
  if (value && !selected) {
    const label = initialContact ? contactLabel(initialContact) : null;
    return (
      <div className="space-y-2">
        <Label>Cliente vinculado</Label>
        <div className="flex items-center justify-between rounded-md border px-3 py-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{label ?? "Contato vinculado"}</p>
            {initialContact?.phone_number && (
              <p className="truncate text-xs text-muted-foreground">{initialContact.phone_number}</p>
            )}
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={clear} disabled={disabled}>
            Trocar
          </Button>
        </div>
      </div>
    );
  }

  // ── Modo criar ───────────────────────────────────────────────────────
  if (creating) {
    return <InlineCreate onCancel={() => setCreating(false)} onCreated={pick} disabled={disabled} />;
  }

  // ── Modo buscar ──────────────────────────────────────────────────────
  return (
    <div className="space-y-2">
      <Label htmlFor="contact-search">Cliente (opcional)</Label>
      <Input
        id="contact-search"
        placeholder="Buscar por nome, telefone ou email…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        disabled={disabled}
        autoComplete="off"
      />
      {debounced.length > 0 && (
        <div className="max-h-44 overflow-y-auto rounded-md border">
          {list.isLoading ? (
            <p className="px-3 py-2 text-sm text-muted-foreground">Buscando…</p>
          ) : results.length === 0 ? (
            <p className="px-3 py-2 text-sm text-muted-foreground">Nenhum contato encontrado.</p>
          ) : (
            results.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => pick(c)}
                disabled={disabled}
                className="flex w-full flex-col items-start px-3 py-2 text-left hover:bg-accent"
              >
                <span className="text-sm font-medium">{contactLabel(c)}</span>
                {c.phone_number && (
                  <span className="text-xs text-muted-foreground">{c.phone_number}</span>
                )}
              </button>
            ))
          )}
        </div>
      )}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setCreating(true)}
        disabled={disabled}
      >
        + Criar novo contato
      </Button>
    </div>
  );
}

// ── Mini-form de criação inline ────────────────────────────────────────
function InlineCreate({
  onCancel,
  onCreated,
  disabled,
}: {
  onCancel: () => void;
  onCreated: (c: Contact) => void;
  disabled: boolean;
}) {
  const create = useCreateContact();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    const payload: Record<string, unknown> = { source: "manual" };
    if (name.trim()) payload.name = name.trim();
    if (phone.trim()) payload.phone_number = phone.trim();
    if (!name.trim() && !phone.trim()) {
      setError("Informe pelo menos o nome ou o telefone.");
      return;
    }
    const parsed = contactCreateSchema.safeParse(payload);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Dados inválidos");
      return;
    }
    try {
      const res = await create.mutateAsync(parsed.data as ContactCreate);
      toast.success("Contato criado");
      onCreated(res.data);
    } catch {
      // toast já mostrado pelo hook
    }
  }

  return (
    <div className="space-y-2 rounded-md border p-3">
      <Label>Novo contato</Label>
      <Input
        placeholder="Nome"
        value={name}
        onChange={(e) => setName(e.target.value)}
        disabled={disabled || create.isPending}
        autoComplete="off"
      />
      <Input
        placeholder="Telefone E.164 (+5533999998888)"
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        disabled={disabled || create.isPending}
        autoComplete="off"
      />
      {error && <p className="text-xs text-error-fg">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={create.isPending}>
          Cancelar
        </Button>
        <Button type="button" size="sm" onClick={submit} disabled={create.isPending}>
          {create.isPending ? "Criando…" : "Criar e vincular"}
        </Button>
      </div>
    </div>
  );
}
