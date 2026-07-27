"use client";
import type { ReactNode } from "react";
import { Sidebar } from "@/components/shell/Sidebar";
import { TopBar } from "@/components/shell/TopBar";
import { MessageNotifier } from "@/components/app/MessageNotifier";
import { cn } from "@/lib/utils";
import type { Brand } from "@/lib/brand";

interface AppShellProps {
  sidebarCollapsed: boolean;
  brand: Brand;
  children: ReactNode;
}

export function AppShell({ sidebarCollapsed, brand, children }: AppShellProps) {
  return (
    <div data-brand={brand} className="flex min-h-screen w-full bg-background">
      <Sidebar collapsed={sidebarCollapsed} />
      <div
        className={cn(
          "flex min-h-screen flex-1 flex-col transition-[margin] duration-200",
          sidebarCollapsed ? "ml-16" : "ml-60",
        )}
      >
        <TopBar />
        {/* Avisa de cada mensagem recebida enquanto o CRM está aberto (som +
            notificação do sistema + contador no título), como o WhatsApp Web. */}
        <MessageNotifier />
        <main className="flex-1 overflow-auto p-6">{children}</main>
      </div>
    </div>
  );
}
