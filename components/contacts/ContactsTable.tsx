"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { format, formatRelative } from "date-fns";
import { ptBR } from "date-fns/locale";
import { toast } from "sonner";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Check, WhatsappLogo, ArrowRight, PhoneCall, Trash } from "@/lib/ui/icons";
import { useActiveOrg } from "@/hooks/auth/AuthProvider";
import { useUpdateContact } from "@/hooks/contacts/useUpdateContact";
import { useContactConversation, useOpenContactLead } from "@/hooks/contacts/useContactActions";
import { useDeleteContacts } from "@/hooks/contacts/useDeleteContacts";
import { canManageTeam } from "@/lib/auth/permissions";
import {
  CONTACT_FIELD,
  CONTACT_STATUS_DONE,
  CONTACT_STATUS_OPTIONS,
  contactCallLog,
  contactFieldText,
} from "@/lib/contacts/fields";
import { newLeadRouteFor } from "@/lib/kanban/new-lead-handoff";
import { hasPosvendaModule } from "@/lib/modules";
import type { Contact } from "@/lib/types/contacts";
import { cn } from "@/lib/utils";

interface Props {
  contacts: Contact[];
  /** Opções de "Empreendimento" (vêm do pipeline default, carregadas no servidor). */
  empreendimentos?: string[];
}

/** Radix Select não aceita item com valor "", então "sem valor" tem sentinela. */
const NONE = "__none__";

function displayName(c: Contact): string {
  return c.display_name?.trim() || c.name?.trim() || "—";
}

/**
 * Edição inline de um campo custom do contato: mostra o valor novo na hora e
 * solta o "pendente" quando o servidor confirma (a lista é invalidada depois
 * do PATCH, então sem isto o select piscaria de volta pro valor antigo).
 */
function useInlineField(contact: Contact, key: string) {
  const update = useUpdateContact(contact.id);
  const server = contactFieldText(contact.custom_fields, key);
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    if (pending !== null && server === pending) setPending(null);
  }, [server, pending]);

  return {
    value: pending ?? server,
    save: (next: string) => {
      setPending(next);
      update.mutate({ custom_fields: { [key]: next || null } });
    },
  };
}

function InlineSelect({
  value,
  options,
  placeholder,
  onChange,
  label,
}: {
  value: string;
  options: readonly string[];
  placeholder: string;
  onChange: (v: string) => void;
  label: string;
}) {
  return (
    <Select value={value || NONE} onValueChange={(v) => onChange(v === NONE ? "" : v)}>
      <SelectTrigger className="h-8 w-full min-w-[9.5rem] text-xs" aria-label={label}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>—</SelectItem>
        {options.map((o) => (
          <SelectItem key={o} value={o}>
            {o}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function EmpreendimentoCell({ contact, options }: { contact: Contact; options: string[] }) {
  const field = useInlineField(contact, CONTACT_FIELD.empreendimento);
  if (options.length === 0) {
    return <span className="text-sm text-muted-foreground">{field.value || "—"}</span>;
  }
  return (
    <InlineSelect
      value={field.value}
      options={options}
      placeholder="—"
      onChange={field.save}
      label={`Empreendimento de ${displayName(contact)}`}
    />
  );
}

/**
 * "Liguei": marca com data e hora da ligação (fica o registro, não só o "sim").
 * Clique marca com o horário atual; clique de novo desmarca.
 */
function LigueiCell({ contact }: { contact: Contact }) {
  const update = useUpdateContact(contact.id);
  const server = contactCallLog(contact.custom_fields);
  const [pending, setPending] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    if (pending === undefined) return;
    const serverRaw = (contact.custom_fields?.[CONTACT_FIELD.liguei] ?? null) as unknown;
    const serverValue = typeof serverRaw === "string" ? serverRaw : serverRaw === true ? "" : null;
    if (serverValue === pending || (pending === null && serverValue === null))
      setPending(undefined);
  }, [contact.custom_fields, pending]);

  const value =
    pending === undefined ? (server.marked ? (server.at?.toISOString() ?? "") : null) : pending;
  const marked = value !== null;
  const at = value ? new Date(value) : null;

  return (
    <button
      type="button"
      aria-pressed={marked}
      aria-label={
        marked
          ? `Desmarcar ligação para ${displayName(contact)}`
          : `Registrar ligação para ${displayName(contact)}`
      }
      title={
        marked
          ? at
            ? `Ligação registrada em ${format(at, "dd/MM/yyyy 'às' HH:mm", { locale: ptBR })}. Clique para desmarcar.`
            : "Marcado sem horário. Clique para desmarcar."
          : "Registrar que você ligou agora"
      }
      onClick={() => {
        const next = marked ? null : new Date().toISOString();
        setPending(next);
        update.mutate({ custom_fields: { [CONTACT_FIELD.liguei]: next } });
      }}
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border px-2 py-1 text-xs",
        "transition-colors duration-fast ease-out",
        marked
          ? "border-success/40 bg-success-bg font-medium text-success-fg"
          : "border-border bg-field text-text-subtle hover:border-border-strong hover:text-text-muted",
      )}
    >
      {marked ? (
        <>
          <Check size={13} weight="bold" aria-hidden />
          <span className="tabular-nums">
            {at ? format(at, "dd/MM HH:mm", { locale: ptBR }) : "marcado"}
          </span>
        </>
      ) : (
        <>
          <PhoneCall size={13} weight="regular" aria-hidden />
          <span>Registrar</span>
        </>
      )}
    </button>
  );
}

function ActionsCells({ contact }: { contact: Contact }) {
  const router = useRouter();
  const openLead = useOpenContactLead();
  const conversation = useContactConversation();
  const hasPhone = !!contact.phone_number;

  async function onOpenLead() {
    try {
      const info = (await openLead.mutateAsync(contact.id)).data;
      if (info.reincidente) {
        toast.warning(
          `Cliente já tem atendimento aberto${info.external_id ? ` (${info.external_id})` : ""} — abrindo ele.`,
        );
      }
      router.push(newLeadRouteFor(info));
    } catch {
      // erro já exibido pelo hook
    }
  }

  async function onWhatsapp() {
    try {
      const res = await conversation.mutateAsync(contact.id);
      router.push(`/app/inbox?id=${res.data.conversation_id}`);
    } catch {
      // erro já exibido pelo hook
    }
  }

  return (
    <>
      <TableCell className="whitespace-nowrap">
        <Button
          size="sm"
          variant="outline"
          onClick={onOpenLead}
          disabled={openLead.isPending || contact.is_anonymized}
        >
          <span>{openLead.isPending ? "Abrindo…" : "Abrir"}</span>
          <ArrowRight size={14} weight="bold" aria-hidden />
        </Button>
      </TableCell>
      <TableCell className="whitespace-nowrap">
        <Button
          size="sm"
          variant="ghost"
          onClick={onWhatsapp}
          disabled={
            conversation.isPending || !hasPhone || contact.is_blocked || contact.is_anonymized
          }
          title={hasPhone ? "Abrir conversa no WhatsApp" : "Contato sem telefone"}
          aria-label={`Abrir WhatsApp de ${displayName(contact)}`}
        >
          <WhatsappLogo size={18} weight="fill" className="text-success" aria-hidden />
        </Button>
      </TableCell>
    </>
  );
}

function StatusBadges({ contact }: { contact: Contact }) {
  return (
    <div className="flex flex-wrap gap-1">
      {contact.is_anonymized && <Badge variant="destructive">Anonimizado</Badge>}
      {contact.is_blocked && <Badge variant="warning">Bloqueado</Badge>}
      {!contact.is_anonymized && !contact.is_blocked && <Badge variant="success">Ativo</Badge>}
    </div>
  );
}

/**
 * Uma linha. O status mora AQUI (não dentro da célula) porque a linha inteira
 * fica verde quando é "Doc. Assinado" — e tem que ficar verde no clique, antes do
 * servidor responder, senão a marcação parece travada.
 *
 * ⚠️ Os fundos usam `!bg-…`: o `TableRow` do design system traz
 * `hover:bg-muted/50`, e entre duas utilitárias de mesma especificidade quem
 * ganha é a ordem no CSS compilado — ou seja, sorte. O `!important` torna o
 * resultado previsível (custo: linha destacada não muda de cor no hover).
 */
function ContactRow({
  contact,
  posvenda,
  empreendimentos,
  selectable,
  selected,
  onToggle,
}: {
  contact: Contact;
  posvenda: boolean;
  empreendimentos: string[];
  selectable: boolean;
  selected: boolean;
  onToggle: (id: string, checked: boolean) => void;
}) {
  const status = useInlineField(contact, CONTACT_FIELD.status);
  const done = posvenda && status.value === CONTACT_STATUS_DONE;

  return (
    <TableRow
      className={cn(selected ? "!bg-accent-soft" : done ? "!bg-success-bg" : undefined)}
      data-state={selected ? "selected" : undefined}
    >
      {selectable && (
        <TableCell className="w-10">
          <input
            type="checkbox"
            className="size-4 cursor-pointer accent-accent"
            checked={selected}
            onChange={(e) => onToggle(contact.id, e.target.checked)}
            aria-label={`Selecionar ${displayName(contact)}`}
          />
        </TableCell>
      )}
      <TableCell className="font-medium">
        <Link href={`/app/contacts/${contact.id}`} className="hover:underline">
          {displayName(contact)}
        </Link>
      </TableCell>
      <TableCell className="text-muted-foreground">{contact.email ?? "—"}</TableCell>
      <TableCell className="whitespace-nowrap text-muted-foreground">
        {contact.phone_number ?? "—"}
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-1">
          {contact.tags.length === 0 ? (
            <span className="text-xs text-muted-foreground">—</span>
          ) : (
            contact.tags.map((t) => (
              <Badge key={t} variant="neutral">
                {t}
              </Badge>
            ))
          )}
        </div>
      </TableCell>

      {posvenda ? (
        <>
          <TableCell>
            <EmpreendimentoCell contact={contact} options={empreendimentos} />
          </TableCell>
          <ActionsCells contact={contact} />
          <TableCell>
            <LigueiCell contact={contact} />
          </TableCell>
          <TableCell>
            <InlineSelect
              value={status.value}
              options={CONTACT_STATUS_OPTIONS}
              placeholder="—"
              onChange={status.save}
              label={`Status de ${displayName(contact)}`}
            />
          </TableCell>
        </>
      ) : (
        <>
          <TableCell className="text-sm text-muted-foreground">
            {contact.last_activity_at
              ? formatRelative(new Date(contact.last_activity_at), new Date(), { locale: ptBR })
              : "—"}
          </TableCell>
          <TableCell>
            <StatusBadges contact={contact} />
          </TableCell>
        </>
      )}
    </TableRow>
  );
}

export function ContactsTable({ contacts, empreendimentos = [] }: Props) {
  const activeOrg = useActiveOrg();
  // Pós-venda (atendente único): a lista de contatos é tela de trabalho ativo —
  // sai "Última atividade"/status do cadastro, entram as colunas de abordagem.
  const posvenda = hasPosvendaModule(activeOrg?.orgId);
  // Apagar contato é irreversível: gerente pra cima. A atendente não vê nem a
  // coluna de seleção (a rota também recusa, esta é só a metade visual da trava).
  const canDelete = canManageTeam(activeOrg?.role);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const del = useDeleteContacts();
  const allRef = useRef<HTMLInputElement>(null);

  // Filtro/busca/refetch mudam a lista: solta da seleção quem saiu da tela, pra
  // não apagar às cegas um contato que o usuário não está mais vendo.
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const visible = new Set(contacts.map((c) => c.id));
      const next = new Set([...prev].filter((id) => visible.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [contacts]);

  const allChecked = contacts.length > 0 && selected.size === contacts.length;
  useEffect(() => {
    if (allRef.current) {
      allRef.current.indeterminate = selected.size > 0 && !allChecked;
    }
  }, [selected.size, allChecked]);

  const selectedNames = useMemo(
    () =>
      contacts
        .filter((c) => selected.has(c.id))
        .slice(0, 5)
        .map(displayName),
    [contacts, selected],
  );

  function toggle(id: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function runDelete() {
    try {
      const { deleted, skipped } = (await del.mutateAsync([...selected])).data;
      setConfirmOpen(false);
      // Mantém marcados só os recusados: o usuário vê exatamente o que sobrou.
      setSelected(new Set(skipped.map((s) => s.id)));
      if (deleted.length > 0) {
        toast.success(`${deleted.length} contato${deleted.length > 1 ? "s" : ""} apagado${deleted.length > 1 ? "s" : ""}`);
      }
      if (skipped.length > 0) {
        const detalhe = skipped
          .slice(0, 3)
          .map((s) => `${s.name} (${s.reason})`)
          .join("; ");
        toast.warning(
          `${skipped.length} mantido${skipped.length > 1 ? "s" : ""} por ter histórico: ${detalhe}${skipped.length > 3 ? "…" : ""}`,
          { duration: 9000 },
        );
      }
    } catch {
      // erro já exibido pelo hook
    }
  }

  return (
    <>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              {canDelete && (
                <TableHead className="w-10">
                  <input
                    ref={allRef}
                    type="checkbox"
                    className="size-4 cursor-pointer accent-accent"
                    checked={allChecked}
                    onChange={(e) =>
                      setSelected(e.target.checked ? new Set(contacts.map((c) => c.id)) : new Set())
                    }
                    aria-label="Selecionar todos os contatos da tela"
                  />
                </TableHead>
              )}
              <TableHead>Nome</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Telefone</TableHead>
              <TableHead>Tags</TableHead>
              {posvenda ? (
                <>
                  <TableHead>Empreendimento</TableHead>
                  <TableHead>Abrir atendimento</TableHead>
                  <TableHead>WhatsApp</TableHead>
                  <TableHead>Liguei (data e hora)</TableHead>
                  <TableHead>Status</TableHead>
                </>
              ) : (
                <>
                  <TableHead>Última atividade</TableHead>
                  <TableHead>Status</TableHead>
                </>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {contacts.map((c) => (
              <ContactRow
                key={c.id}
                contact={c}
                posvenda={posvenda}
                empreendimentos={empreendimentos}
                selectable={canDelete}
                selected={selected.has(c.id)}
                onToggle={toggle}
              />
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Barra flutuante: fica fora do fluxo de propósito, pra não empurrar a
          tabela nem sumir dentro do scroll horizontal do Card. */}
      {canDelete && selected.size > 0 && (
        <div className="fixed bottom-6 left-1/2 z-30 flex -translate-x-1/2 items-center gap-3 rounded-xl border border-border bg-surface px-4 py-2.5 shadow-lg">
          <span className="text-sm font-medium text-text">
            {selected.size} selecionado{selected.size > 1 ? "s" : ""}
          </span>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => setConfirmOpen(true)}
            disabled={del.isPending}
          >
            <Trash size={14} weight="bold" aria-hidden />
            <span>Apagar</span>
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Limpar
          </Button>
        </div>
      )}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Apagar {selected.size} contato{selected.size > 1 ? "s" : ""}?
            </DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2">
                <p>Não tem como desfazer.</p>
                <p>
                  Quem já tem <strong>conversa, mensagem ou atendimento</strong> não é apagado — o
                  sistema mantém esses e avisa quais foram, para não deixar atendimento sem cliente.
                </p>
                {selectedNames.length > 0 && (
                  <p className="text-xs">
                    {selectedNames.join(", ")}
                    {selected.size > selectedNames.length
                      ? ` e mais ${selected.size - selectedNames.length}`
                      : ""}
                  </p>
                )}
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)} disabled={del.isPending}>
              Cancelar
            </Button>
            <Button variant="destructive" onClick={runDelete} disabled={del.isPending}>
              {del.isPending ? "Apagando…" : "Apagar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
