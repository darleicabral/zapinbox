"use client";
import { useEffect, useState } from "react";
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
import { contactPatchSchema, type ContactPatch } from "@/lib/schemas/contacts";
import { useUpdateContact } from "@/hooks/contacts/useUpdateContact";
import { CONTACT_FIELD, contactFieldText } from "@/lib/contacts/fields";
import type { Contact } from "@/lib/types/contacts";
import { EmpreendimentoField } from "./EmpreendimentoField";

interface FormShape {
  name?: string;
  email?: string;
  phone_number?: string;
  tagsRaw?: string;
}

interface Props {
  contact: Contact;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Opções cadastradas; vazio esconde o campo. */
  empreendimentos?: string[];
}

export function EditContactDialog({ contact, open, onOpenChange, empreendimentos = [] }: Props) {
  const update = useUpdateContact(contact.id);
  const [serverError, setServerError] = useState<string | null>(null);
  const [empreendimento, setEmpreendimento] = useState(() =>
    contactFieldText(contact.custom_fields, CONTACT_FIELD.empreendimento),
  );

  const form = useForm<FormShape>({
    defaultValues: {
      name: contact.name ?? "",
      email: contact.email ?? "",
      phone_number: contact.phone_number ?? "",
      tagsRaw: contact.tags.join(", "),
    },
  });

  useEffect(() => {
    if (open) {
      form.reset({
        name: contact.name ?? "",
        email: contact.email ?? "",
        phone_number: contact.phone_number ?? "",
        tagsRaw: contact.tags.join(", "),
      });
      setEmpreendimento(contactFieldText(contact.custom_fields, CONTACT_FIELD.empreendimento));
    }
  }, [open, contact, form]);

  async function onSubmit(values: FormShape) {
    setServerError(null);
    const tags = (values.tagsRaw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const payload: Record<string, unknown> = {};
    if (values.name?.trim()) payload.name = values.name.trim();
    if (values.email?.trim()) payload.email = values.email.trim();
    if (values.phone_number?.trim()) payload.phone_number = values.phone_number.trim();
    payload.tags = tags;
    // O handler faz merge raso em custom_fields — mandar só esta chave é seguro.
    payload.custom_fields = { [CONTACT_FIELD.empreendimento]: empreendimento || null };

    const parsed = contactPatchSchema.safeParse(payload);
    if (!parsed.success) {
      setServerError(parsed.error.issues[0]?.message ?? "Dados inválidos");
      return;
    }
    try {
      await update.mutateAsync(parsed.data as ContactPatch);
      toast.success("Contato atualizado");
      onOpenChange(false);
    } catch {
      // hook handles toast
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Editar contato</DialogTitle>
          <DialogDescription>Atualize os dados deste contato.</DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="ec-name">Nome</Label>
            <Input id="ec-name" {...form.register("name")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ec-email">Email</Label>
            <Input id="ec-email" type="email" {...form.register("email")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ec-phone">Telefone (E.164)</Label>
            <Input id="ec-phone" {...form.register("phone_number")} />
          </div>
          <EmpreendimentoField
            id="ec-empreendimento"
            options={empreendimentos}
            value={empreendimento}
            onChange={setEmpreendimento}
          />
          <div className="space-y-2">
            <Label htmlFor="ec-tags">Tags</Label>
            <Input id="ec-tags" {...form.register("tagsRaw")} />
          </div>
          {serverError && <p className="text-sm text-error-fg">{serverError}</p>}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={update.isPending}
            >
              Cancelar
            </Button>
            <Button type="submit" disabled={update.isPending}>
              {update.isPending ? "Salvando…" : "Salvar"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
