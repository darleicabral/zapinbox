"use client";
/**
 * Cadastro direto de membro: nome, e-mail, senha inicial e papel, com a lista
 * do que o papel escolhido libera ao lado (RoleCapabilities).
 *
 * Depois de criar, a senha aparece UMA vez para o admin copiar e entregar — o
 * servidor não guarda nada em claro e ninguém consegue recuperar depois.
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowsClockwise, CheckCircle, Copy, Eye, Warning } from "@/lib/ui/icons";
import { RoleCapabilities, ROLE_LABEL } from "@/components/team/RoleCapabilities";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import { ROLES, type Role } from "@/lib/schemas/team";

/** Sem 0/O/1/l/I: a senha vai ser lida em voz alta ou copiada à mão. */
const ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generatePassword(len = 14): string {
  const bytes = new Uint32Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

interface CreatedInfo {
  email: string;
  role: Role;
  password: string;
  password_applied: boolean;
  reactivated: boolean;
}

export function NewMemberForm() {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState(() => generatePassword());
  const [reveal, setReveal] = useState(true);
  const [role, setRole] = useState<Role>("manager");
  const [pending, setPending] = useState(false);
  const [created, setCreated] = useState<CreatedInfo | null>(null);

  const emailValid = useMemo(() => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()), [email]);
  const canSubmit = emailValid && password.length >= 10 && !pending;

  async function onSubmit() {
    if (!canSubmit) return;
    setPending(true);
    try {
      const res = await apiClient.post<{
        data: { email: string; role: Role; password_applied: boolean; reactivated: boolean };
      }>("/api/v1/team/users", {
        email: email.trim().toLowerCase(),
        ...(fullName.trim() ? { full_name: fullName.trim() } : {}),
        password,
        role,
      });
      setCreated({ ...res.data, password });
      toast.success("Usuário cadastrado.");
    } catch (err) {
      showApiError(err);
    } finally {
      setPending(false);
    }
  }

  if (created) {
    return (
      <div className="max-w-xl space-y-4">
        <div className="border-success/40 space-y-2 rounded-lg border bg-success-bg p-4">
          <p className="flex items-center gap-1.5 text-sm font-medium text-success-fg">
            <CheckCircle size={16} weight="fill" aria-hidden />
            {created.reactivated ? "Acesso reativado" : "Usuário cadastrado"} como{" "}
            {ROLE_LABEL[created.role]}
          </p>
          <dl className="space-y-1 text-sm text-text">
            <div className="flex gap-2">
              <dt className="w-20 text-text-muted">E-mail</dt>
              <dd className="font-medium">{created.email}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-20 text-text-muted">Senha</dt>
              <dd className="font-mono font-medium">
                {created.password_applied ? created.password : "a que a pessoa já usava"}
              </dd>
            </div>
          </dl>
          {created.password_applied ? (
            <p className="text-xs text-text-muted">
              Copie agora e entregue pessoalmente. Ninguém recupera esta senha depois, nem eu: só dá
              para definir outra.
            </p>
          ) : (
            <p className="flex items-start gap-1.5 text-xs text-warning-fg">
              <Warning size={13} weight="fill" className="mt-0.5 shrink-0" aria-hidden />
              Esse e-mail já tinha conta no sistema. Vinculei à organização com o papel escolhido e
              NÃO troquei a senha dela.
            </p>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          {created.password_applied && (
            <Button
              variant="outline"
              onClick={() => {
                void navigator.clipboard
                  .writeText(`${created.email} · ${created.password}`)
                  .then(() => toast.success("E-mail e senha copiados."));
              }}
            >
              <Copy size={16} aria-hidden /> Copiar acesso
            </Button>
          )}
          <Button asChild>
            <Link href="/app/team">Ver equipe</Link>
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setCreated(null);
              setFullName("");
              setEmail("");
              setPassword(generatePassword());
              setRole("manager");
            }}
          >
            Cadastrar outro
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,26rem)_minmax(0,22rem)]">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void onSubmit();
        }}
      >
        <div className="space-y-2">
          <Label htmlFor="nm-name">Nome</Label>
          <Input
            id="nm-name"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder="Maria Silva"
            autoComplete="off"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="nm-email">E-mail de acesso</Label>
          <Input
            id="nm-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="maria@empresa.com.br"
            autoComplete="off"
            required
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="nm-pass">Senha inicial</Label>
          <div className="flex gap-2">
            <Input
              id="nm-pass"
              type={reveal ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="font-mono"
              autoComplete="new-password"
              minLength={10}
              required
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="shrink-0"
              onClick={() => setReveal((v) => !v)}
              aria-label={reveal ? "Esconder senha" : "Mostrar senha"}
            >
              <Eye size={16} aria-hidden />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="shrink-0"
              onClick={() => setPassword(generatePassword())}
              aria-label="Gerar outra senha"
              title="Gerar outra senha"
            >
              <ArrowsClockwise size={16} aria-hidden />
            </Button>
          </div>
          <p className="text-xs text-text-subtle">
            Mínimo de 10 caracteres. A pessoa pode trocar depois em Configurações.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="nm-role">Nível de acesso</Label>
          <Select value={role} onValueChange={(v) => setRole(v as Role)}>
            <SelectTrigger id="nm-role">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ROLES.map((r) => (
                <SelectItem key={r} value={r}>
                  {ROLE_LABEL[r]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex gap-2 pt-1">
          <Button type="submit" disabled={!canSubmit}>
            {pending ? "Cadastrando…" : "Cadastrar usuário"}
          </Button>
          <Button asChild type="button" variant="ghost">
            <Link href="/app/team">Cancelar</Link>
          </Button>
        </div>
      </form>

      <RoleCapabilities role={role} className="h-fit" />
    </div>
  );
}
