"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTransition } from "react";
import {
  AddressBook,
  BookOpen,
  Calendar,
  CaretDoubleLeft,
  CaretDoubleRight,
  ChartLineUp,
  Gear,
  Kanban,
  PlugsConnected,
  Robot,
  ShieldCheck,
  UsersThree,
  WhatsappLogo,
} from "@/lib/ui/icons";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { toggleSidebar } from "@/app/actions/shell/toggleSidebar";
import { usePermission, useActiveOrg } from "@/hooks/auth/AuthProvider";
import { ROLE_RANK } from "@/lib/auth/types";
import { hasPosvendaModule } from "@/lib/modules";
import { ConnectionHealthDot } from "@/components/connections/ConnectionHealthDot";
import { Logo } from "@/components/brand/Logo";

interface NavItem {
  href: string;
  label: string;
  icon: PhosphorIcon;
  permission?: string;
  /** Item de módulo opcional por-org (ex.: "posvenda" só p/ Itaville). */
  module?: "posvenda";
  healthDot?: boolean;
  /**
   * Papel mínimo no tenant ativo para o item aparecer. Era `adminOnly`; virou
   * nível porque o Gerente passou a administrar equipe, conexões e IA (26/07).
   */
  minRole?: "manager" | "admin";
}

/**
 * Menu em dois grupos + Configurações fixo no pé (30/07, "menu mais elegante"):
 * o dia a dia da atendente em cima, o que é de gerente/admin embaixo. Grupo que
 * fica sem item depois dos filtros NÃO renderiza o rótulo — atendente não vê
 * cabeçalho "Administração" vazio.
 */
const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: "Operação",
    items: [
      { href: "/app/painel", label: "Painel", icon: ChartLineUp, module: "posvenda" },
      { href: "/app/inbox", label: "WhatsApp", icon: WhatsappLogo },
      { href: "/app/kanban", label: "Atendimentos", icon: Kanban },
      { href: "/app/agenda", label: "Agenda", icon: Calendar, module: "posvenda" },
      { href: "/app/contacts", label: "Contatos", icon: AddressBook },
      { href: "/app/manual", label: "Manuais", icon: BookOpen, module: "posvenda" },
    ],
  },
  {
    label: "Administração",
    items: [
      {
        href: "/app/connections",
        label: "Conexões",
        icon: PlugsConnected,
        healthDot: true,
        minRole: "manager",
      },
      { href: "/app/team", label: "Equipe", icon: UsersThree, minRole: "manager" },
      {
        href: "/app/lgpd/requests",
        label: "LGPD",
        icon: ShieldCheck,
        permission: "lgpd.execute_redact",
        minRole: "manager",
      },
      { href: "/app/ai/agents", label: "Agentes IA", icon: Robot, minRole: "manager" },
    ],
  },
];

/** Sempre no pé, separado do resto: é ajuste, não tarefa. */
const SETTINGS_ITEM: NavItem = { href: "/app/settings", label: "Configurações", icon: Gear };

export function Sidebar({ collapsed }: { collapsed: boolean }) {
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();
  const canLgpd = usePermission("lgpd.execute_redact");
  const activeOrg = useActiveOrg();
  const role = activeOrg?.role;
  const isManager = !!role && ROLE_RANK[role] >= ROLE_RANK.manager;
  const hasRole = (min: "manager" | "admin") => !!role && ROLE_RANK[role] >= ROLE_RANK[min];
  const canPosvenda = hasPosvendaModule(activeOrg?.orgId);

  function canSee(item: NavItem): boolean {
    if (item.minRole && !hasRole(item.minRole)) return false;
    if (item.module === "posvenda") return canPosvenda;
    if (item.permission === "lgpd.execute_redact") return canLgpd || isManager;
    return true;
  }

  /**
   * Item ativo: pílula `accent-soft` + texto forte + ícone no accent (duotone).
   * ⚠️ O texto NÃO usa a cor do accent: medido, `text-accent` sobre `accent-soft`
   * dá 3,73:1 no escuro/Avant (reprova AA p/ 14px). Ícone pode, é gráfico (3:1).
   */
  function renderItem(item: NavItem) {
    const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
    const Icon = item.icon;
    return (
      <Link
        key={item.href}
        href={item.href}
        title={collapsed ? item.label : undefined}
        aria-current={isActive ? "page" : undefined}
        className={cn(
          "relative flex h-9 items-center gap-3 rounded-lg text-sm transition-colors duration-fast ease-out",
          isActive
            ? "bg-accent-soft font-medium text-text"
            : "text-text-muted hover:bg-surface-muted hover:text-text",
          collapsed ? "justify-center px-0" : "px-3",
        )}
      >
        <Icon
          size={19}
          weight={isActive ? "duotone" : "regular"}
          className={cn("shrink-0", isActive && "text-accent")}
          aria-hidden
        />
        {!collapsed && <span className="truncate">{item.label}</span>}
        {item.healthDot && (
          <ConnectionHealthDot
            className={cn(collapsed ? "absolute right-1.5 top-1.5" : "ml-auto")}
          />
        )}
      </Link>
    );
  }

  const groups = NAV_GROUPS.map((g) => ({ ...g, items: g.items.filter(canSee) })).filter(
    (g) => g.items.length > 0,
  );

  return (
    <aside
      className={cn(
        "fixed inset-y-0 left-0 z-30 flex flex-col border-r border-border bg-surface transition-[width] duration-base ease-out",
        collapsed ? "w-16" : "w-60",
      )}
    >
      <div
        className={cn(
          "flex h-14 shrink-0 items-center border-b border-border px-4",
          collapsed ? "justify-center px-0" : "justify-start",
        )}
      >
        <Logo collapsed={collapsed} />
      </div>

      <nav
        className="flex-1 overflow-y-auto px-2 py-3"
        aria-label="Navegação principal"
      >
        {groups.map((group, i) => (
          <div key={group.label} className={cn(i > 0 && (collapsed ? "mt-3" : "mt-5"))}>
            {/* Recolhido não tem espaço p/ rótulo: o grupo virou um traço. */}
            {collapsed
              ? i > 0 && <div aria-hidden className="mx-3 mb-3 h-px bg-border" />
              : (
                  <p className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.09em] text-text-muted">
                    {group.label}
                  </p>
                )}
            <div className="space-y-0.5">{group.items.map(renderItem)}</div>
          </div>
        ))}
      </nav>

      <div className="shrink-0 border-t border-border p-2">
        <div className="space-y-0.5">
          {renderItem(SETTINGS_ITEM)}
          <button
            type="button"
            onClick={() => startTransition(() => toggleSidebar(collapsed))}
            disabled={isPending}
            className={cn(
              "flex h-9 w-full items-center gap-3 rounded-lg text-sm text-text-muted transition-colors duration-fast ease-out hover:bg-surface-muted hover:text-text disabled:opacity-60",
              collapsed ? "justify-center px-0" : "px-3",
            )}
            aria-label={collapsed ? "Expandir menu" : "Recolher menu"}
          >
            {collapsed ? (
              <CaretDoubleRight size={19} className="shrink-0" aria-hidden />
            ) : (
              <CaretDoubleLeft size={19} className="shrink-0" aria-hidden />
            )}
            {!collapsed && <span className="truncate">Recolher</span>}
          </button>
        </div>
      </div>
    </aside>
  );
}
