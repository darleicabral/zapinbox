"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { formatRelative } from "date-fns";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Check, WhatsappLogo, ArrowRight } from "@/lib/ui/icons";
import { useActiveOrg } from "@/hooks/auth/AuthProvider";
import { useUpdateContact } from "@/hooks/contacts/useUpdateContact";
import { useContactConversation, useOpenContactLead } from "@/hooks/contacts/useContactActions";
import {
  CONTACT_FIELD,
  CONTACT_STATUS_OPTIONS,
  contactFieldFlag,
  contactFieldText,
} from "@/lib/contacts/fields";
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

function StatusCell({ contact }: { contact: Contact }) {
  const field = useInlineField(contact, CONTACT_FIELD.status);
  return (
    <InlineSelect
      value={field.value}
      options={CONTACT_STATUS_OPTIONS}
      placeholder="—"
      onChange={field.save}
      label={`Status de ${displayName(contact)}`}
    />
  );
}

/** "Liguei": clique alterna; marcado vira um check verde preenchido. */
function LigueiCell({ contact }: { contact: Contact }) {
  const update = useUpdateContact(contact.id);
  const server = contactFieldFlag(contact.custom_fields, CONTACT_FIELD.liguei);
  const [pending, setPending] = useState<boolean | null>(null);

  useEffect(() => {
    if (pending !== null && server === pending) setPending(null);
  }, [server, pending]);

  const checked = pending ?? server;

  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={`Liguei para ${displayName(contact)}`}
      onClick={() => {
        const next = !checked;
        setPending(next);
        update.mutate({ custom_fields: { [CONTACT_FIELD.liguei]: next } });
      }}
      className={cn(
        "flex size-6 items-center justify-center rounded-md border transition-colors duration-fast ease-out",
        checked
          ? "border-success bg-success text-success-fg"
          : "border-border bg-field text-transparent hover:border-border-strong hover:text-muted-foreground",
      )}
    >
      <Check size={14} weight="bold" aria-hidden />
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
      const res = await openLead.mutateAsync(contact.id);
      const info = res.data;
      if (info.reincidente) {
        toast.warning(
          `Cliente já tem atendimento aberto${info.external_id ? ` (${info.external_id})` : ""} — abrindo ele.`,
        );
      } else {
        toast.success("Atendimento aberto.");
      }
      router.push(`/app/pipelines/${info.pipeline_id}?open=${info.lead_id}`);
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

export function ContactsTable({ contacts, empreendimentos = [] }: Props) {
  // Pós-venda (atendente único): a lista de contatos é tela de trabalho ativo —
  // sai "Última atividade"/status do cadastro, entram as colunas de abordagem.
  const posvenda = hasPosvendaModule(useActiveOrg()?.orgId);

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Nome</TableHead>
            <TableHead>Email</TableHead>
            <TableHead>Telefone</TableHead>
            <TableHead>Tags</TableHead>
            {posvenda ? (
              <>
                <TableHead>Empreendimento</TableHead>
                <TableHead>Abrir atendimento</TableHead>
                <TableHead>WhatsApp</TableHead>
                <TableHead>Liguei</TableHead>
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
            <TableRow key={c.id}>
              <TableCell className="font-medium">
                <Link href={`/app/contacts/${c.id}`} className="hover:underline">
                  {displayName(c)}
                </Link>
              </TableCell>
              <TableCell className="text-muted-foreground">{c.email ?? "—"}</TableCell>
              <TableCell className="whitespace-nowrap text-muted-foreground">
                {c.phone_number ?? "—"}
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  {c.tags.length === 0 ? (
                    <span className="text-xs text-muted-foreground">—</span>
                  ) : (
                    c.tags.map((t) => (
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
                    <EmpreendimentoCell contact={c} options={empreendimentos} />
                  </TableCell>
                  <ActionsCells contact={c} />
                  <TableCell>
                    <LigueiCell contact={c} />
                  </TableCell>
                  <TableCell>
                    <StatusCell contact={c} />
                  </TableCell>
                </>
              ) : (
                <>
                  <TableCell className="text-sm text-muted-foreground">
                    {c.last_activity_at
                      ? formatRelative(new Date(c.last_activity_at), new Date(), { locale: ptBR })
                      : "—"}
                  </TableCell>
                  <TableCell>
                    <StatusBadges contact={c} />
                  </TableCell>
                </>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
