import { cn } from "@/lib/utils";

/**
 * Marca ZapInbox.
 *
 * O badge usa o degradê da marca ativa (`var(--brand-grad)`), então herda
 * automaticamente verde (ZapInbox) ou vinho (Avant) conforme o `data-brand`
 * do escopo em volta. Componente puro (SVG inline, sem hooks) — pode ser usado
 * tanto em Server quanto em Client Components.
 */
export function LogoMark({
  className,
  title = "ZapInbox",
}: {
  className?: string;
  title?: string;
}) {
  return (
    <span
      role="img"
      aria-label={title}
      className={cn(
        "inline-grid aspect-square place-items-center rounded-[28%] text-white shadow-sm",
        className,
      )}
      style={{ background: "var(--brand-grad)" }}
    >
      <svg viewBox="0 0 24 24" aria-hidden className="h-[56%] w-[56%]">
        <polygon
          points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"
          fill="currentColor"
        />
      </svg>
    </span>
  );
}

/** Badge + wordmark "ZapInbox". Colapsado mostra só o badge. */
export function Logo({
  collapsed = false,
  className,
  markClassName,
  wordmarkClassName,
}: {
  collapsed?: boolean;
  className?: string;
  markClassName?: string;
  wordmarkClassName?: string;
}) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <LogoMark className={cn("h-8 w-8", markClassName)} />
      {!collapsed && (
        <span
          className={cn(
            "text-[15px] font-semibold leading-none tracking-tight text-text",
            wordmarkClassName,
          )}
        >
          Zap<span className="text-accent">Inbox</span>
        </span>
      )}
    </span>
  );
}
