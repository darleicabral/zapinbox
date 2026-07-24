"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTransition } from "react";
import { Kanban, Users, UsersThree, Gear, CaretDoubleLeft, CaretDoubleRight, Inbox, ScalesSimple, Robot, PlugsConnected, Gauge, ClipboardText, Calendar } from "@/lib/ui/icons";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { toggleSidebar } from "@/app/actions/shell/toggleSidebar";
import { usePermission, useActiveOrg } from "@/hooks/auth/AuthProvider";
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
  /** Visível só para role=admin do tenant ativo (não platform_admin/manager). */
  adminOnly?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { href: "/app/painel", label: "Dash", icon: Gauge, module: "posvenda" },
  { href: "/app/inbox", label: "WhatsApp", icon: Inbox },
  { href: "/app/kanban", label: "Atendimentos", icon: Kanban },
  { href: "/app/agenda", label: "Agenda", icon: Calendar, module: "posvenda" },
  { href: "/app/manual", label: "Manuais", icon: ClipboardText, module: "posvenda" },
  { href: "/app/contacts", label: "Contatos", icon: Users },
  { href: "/app/connections", label: "Conexões", icon: PlugsConnected, healthDot: true },
  { href: "/app/team", label: "Equipe", icon: UsersThree, adminOnly: true },
  { href: "/app/lgpd/requests", label: "LGPD", icon: ScalesSimple, permission: "lgpd.execute_redact" },
  { href: "/app/ai/agents", label: "Agentes IA", icon: Robot, adminOnly: true },
  { href: "/app/settings", label: "Configurações", icon: Gear },
];

export function Sidebar({ collapsed }: { collapsed: boolean }) {
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();
  const canLgpd = usePermission("lgpd.execute_redact");
  const activeOrg = useActiveOrg();
  const isAdmin = activeOrg?.role === "admin";
  const canPosvenda = hasPosvendaModule(activeOrg?.orgId);

  return (
    <aside
      className={cn(
        "fixed inset-y-0 left-0 z-30 flex flex-col border-r bg-card transition-[width] duration-200",
        collapsed ? "w-16" : "w-60",
      )}
    >
      <div className={cn("flex items-center border-b px-4 h-14", collapsed ? "justify-center" : "justify-start")}>
        <Logo collapsed={collapsed} />
      </div>
      <nav className="flex-1 space-y-1 p-2" aria-label="Navegação principal">
        {NAV_ITEMS.filter((item) => {
          if (item.adminOnly) return isAdmin;
          if (item.module === "posvenda") return canPosvenda;
          if (item.permission === "lgpd.execute_redact") return canLgpd;
          return true;
        }).map((item) => {
          const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              title={collapsed ? item.label : undefined}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "relative flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                isActive ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                collapsed && "justify-center px-2",
              )}
            >
              <Icon size={18} weight={isActive ? "fill" : "regular"} aria-hidden />
              {!collapsed && <span className="truncate">{item.label}</span>}
              {item.healthDot && (
                <ConnectionHealthDot
                  className={cn(collapsed ? "absolute right-1.5 top-1.5" : "ml-auto")}
                />
              )}
            </Link>
          );
        })}
      </nav>
      <div className="border-t p-2">
        <button
          type="button"
          onClick={() => startTransition(() => toggleSidebar(collapsed))}
          disabled={isPending}
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-3 py-2 text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            collapsed && "justify-center px-2",
          )}
          aria-label={collapsed ? "Expandir sidebar" : "Recolher sidebar"}
        >
          {collapsed ? <CaretDoubleRight size={14} aria-hidden /> : <CaretDoubleLeft size={14} aria-hidden />}
          {!collapsed && <span>Recolher</span>}
        </button>
      </div>
    </aside>
  );
}
