"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ArrowRight } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

interface ManualTab {
  key: string;
  label: string;
  /** URL para embedar no iframe. */
  embedUrl: string;
  /** URL para abrir em nova aba (pode ser igual ao embed). */
  openUrl: string;
  openLabel: string;
}

/**
 * Visualizador de manuais com abas — "Manual do sistema" (playbook de como
 * operar o CRM) e "Manual de atendimento" (roteiro/Google Doc). Recebe só as
 * abas disponíveis para a org (se só houver uma, mostra sem o alternador).
 */
export function ManualsViewer({ tabs }: { tabs: ManualTab[] }) {
  const [active, setActive] = useState(tabs[0]?.key ?? "");
  const current = tabs.find((t) => t.key === active) ?? tabs[0];
  if (!current) return null;

  return (
    <div className="flex h-full flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Manuais</h1>
          <p className="text-sm text-muted-foreground">
            Guias de consulta para a operação de pós-venda.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {tabs.length > 1 && (
            <div className="inline-flex rounded-lg border border-border bg-surface-muted p-0.5 text-sm">
              {tabs.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setActive(t.key)}
                  className={cn(
                    "rounded-md px-3 py-1 transition-colors duration-fast ease-out",
                    t.key === current.key
                      ? "bg-surface font-medium text-text shadow-xs"
                      : "text-text-muted hover:text-text",
                  )}
                >
                  {t.label}
                </button>
              ))}
            </div>
          )}
          <Button asChild variant="secondary" size="sm">
            <a href={current.openUrl} target="_blank" rel="noreferrer">
              {current.openLabel}
              <ArrowRight size={14} aria-hidden />
            </a>
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden rounded-lg border bg-white">
        <iframe
          key={current.key}
          src={current.embedUrl}
          title={current.label}
          className="h-full w-full border-0"
          loading="lazy"
        />
      </div>
    </div>
  );
}
