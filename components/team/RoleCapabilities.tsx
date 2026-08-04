"use client";
/**
 * O que cada papel PODE fazer, em português, ao lado do seletor.
 *
 * Existe porque "admin / manager / agent / viewer" não diz nada para quem está
 * cadastrando alguém: o admin escolhia no escuro e dava poder demais. A lista
 * espelha as travas reais do código (`ROLE_RANK[...] < ROLE_RANK.x` nas rotas);
 * ao mexer numa trava, mexa aqui também.
 */
import { Check, X } from "@/lib/ui/icons";
import type { Role } from "@/lib/schemas/team";
import { cn } from "@/lib/utils";

export const ROLE_LABEL: Record<Role, string> = {
  viewer: "Observador",
  agent: "Atendente",
  manager: "Gerente",
  admin: "Administrador",
};

export const ROLE_SUMMARY: Record<Role, string> = {
  viewer: "Só olha. Não responde cliente nem edita nada.",
  agent: "O dia a dia do atendimento: responde, abre e move atendimentos.",
  manager:
    "Atendimento + equipe, WhatsApp, LGPD e ligar/pausar a IA. Não mexe em admin nem na configuração do sistema.",
  admin: "Poder total no tenant, incluindo configuração, chaves e promover admin.",
};

/** Capacidade → papel mínimo que a libera (bate com as travas das rotas). */
const CAPABILITIES: Array<{ label: string; min: Role }> = [
  { label: "Ver painel, atendimentos e contatos", min: "viewer" },
  { label: "Responder no WhatsApp e abrir atendimento", min: "agent" },
  { label: "Importar contatos", min: "agent" },
  { label: "Ver CPF do cliente", min: "manager" },
  { label: "Ver agentes de IA, versões e consumo", min: "manager" },
  { label: "Base de conhecimento da IA", min: "manager" },
  { label: "Ligar, pausar e publicar o agente de IA", min: "manager" },
  { label: "Conectar e reconectar o WhatsApp", min: "manager" },
  { label: "LGPD: ver e aprovar pedidos", min: "manager" },
  { label: "Convidar, cadastrar e remover pessoas (menos admins)", min: "manager" },
  { label: "Definir quais números de WhatsApp cada pessoa vê", min: "manager" },
  { label: "Apagar contatos em lote", min: "manager" },
  { label: "Criar, editar e arquivar agente de IA", min: "admin" },
  { label: "Chaves de IA e orçamento", min: "admin" },
  { label: "Promover alguém a administrador", min: "admin" },
  { label: "Anonimizar contato fora do fluxo de pedido (LGPD)", min: "admin" },
  { label: "Configurações do tenant e opções dos campos", min: "admin" },
  { label: "Tokens de API", min: "admin" },
];

const RANK: Record<Role, number> = { viewer: 1, agent: 2, manager: 3, admin: 4 };

export function RoleCapabilities({ role, className }: { role: Role; className?: string }) {
  return (
    <div className={cn("rounded-lg border border-border bg-surface-muted p-3", className)}>
      <p className="text-xs font-medium text-text">
        {ROLE_LABEL[role]} ·{" "}
        <span className="font-normal text-text-muted">{ROLE_SUMMARY[role]}</span>
      </p>
      <ul className="mt-2 space-y-1">
        {CAPABILITIES.map((c) => {
          const allowed = RANK[role] >= RANK[c.min];
          return (
            <li
              key={c.label}
              className={cn(
                "flex items-start gap-1.5 text-xs",
                allowed ? "text-text-muted" : "text-text-subtle",
              )}
            >
              {allowed ? (
                <Check
                  size={13}
                  weight="bold"
                  className="mt-0.5 shrink-0 text-success"
                  aria-hidden
                />
              ) : (
                <X size={13} weight="bold" className="mt-0.5 shrink-0 opacity-50" aria-hidden />
              )}
              <span className={cn(!allowed && "line-through decoration-1")}>{c.label}</span>
            </li>
          );
        })}
      </ul>
      {role === "admin" && (
        <p className="mt-2 text-[11px] text-warning-fg">
          Administrador é obrigado a cadastrar 2 fatores (MFA) no primeiro login.
        </p>
      )}
    </div>
  );
}
