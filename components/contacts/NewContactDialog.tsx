"use client";
import { useState } from "react";
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
import { contactCreateSchema, type ContactCreate } from "@/lib/schemas/contacts";
import { useCreateContact } from "@/hooks/contacts/useCreateContact";
import { CONTACT_FIELD } from "@/lib/contacts/fields";
import { EmpreendimentoField } from "./EmpreendimentoField";

interface FormShape {
  name?: string;
  email?: string;
  phone_number?: string;
  cpf?: string;
  tagsRaw?: string;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Opções cadastradas; vazio esconde o campo (org sem empreendimentos). */
  empreendimentos?: string[];
}

export function NewContactDialog({ open, onOpenChange, empreendimentos = [] }: Props) {
  const create = useCreateContact();
  const [serverError, setServerError] = useState<string | null>(null);
  const [empreendimento, setEmpreendimento] = useState("");

  const form = useForm<FormShape>({
    defaultValues: { name: "", email: "", phone_number: "", cpf: "", tagsRaw: "" },
  });

  async function onSubmit(values: FormShape) {
    setServerError(null);
    const tags = (values.tagsRaw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const payload: Record<string, unknown> = { source: "manual" };
    if (values.name?.trim()) payload.name = values.name.trim();
    if (values.email?.trim()) payload.email = values.email.trim();
    if (values.phone_number?.trim()) payload.phone_number = values.phone_number.trim();
    if (values.cpf?.trim()) payload.cpf = values.cpf.trim();
    if (tags.length) payload.tags = tags;
    if (empreendimento) payload.custom_fields = { [CONTACT_FIELD.empreendimento]: empreendimento };

    const parsed = contactCreateSchema.safeParse(payload);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      setServerError(first?.message ?? "Dados inválidos");
      return;
    }

    try {
      await create.mutateAsync(parsed.data as ContactCreate);
      toast.success("Contato criado");
      form.reset();
      setEmpreendimento("");
      onOpenChange(false);
    } catch {
      // error toast already handled by hook
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Novo contato</DialogTitle>
          <DialogDescription>
            Preencha pelo menos um identificador (email ou telefone).
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Nome</Label>
            <Input id="name" {...form.register("name")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" {...form.register("email")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="phone_number">Telefone (E.164)</Label>
            <Input
              id="phone_number"
              placeholder="+5511999998888"
              {...form.register("phone_number")}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cpf">CPF (opcional)</Label>
            <Input id="cpf" placeholder="00000000000" {...form.register("cpf")} />
          </div>
          <EmpreendimentoField
            id="nc-empreendimento"
            options={empreendimentos}
            value={empreendimento}
            onChange={setEmpreendimento}
          />
          <div className="space-y-2">
            <Label htmlFor="tagsRaw">Tags (separadas por vírgula)</Label>
            <Input id="tagsRaw" placeholder="vip, recompra" {...form.register("tagsRaw")} />
          </div>
          {serverError && <p className="text-sm text-error-fg">{serverError}</p>}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={create.isPending}
            >
              Cancelar
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? "Criando…" : "Criar contato"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
