"use client";
import type { CSSProperties } from "react";
import { format, formatDistanceToNowStrict } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Robot } from "@/lib/ui/icons";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";

interface Props {
  conversation: ConversationWithContact;
  isSelected: boolean;
  onSelect: (id: string) => void;
}

const STATUS_DOT: Record<string, string> = {
  open: "bg-accent",
  claimed: "bg-info",
  ai_handling: "bg-purple-500",
  closed: "bg-neutral-400",
  archived: "bg-neutral-300",
};

/**
 * Hue estável por contato (0–360) para o avatar. Mesmo contato, mesma cor,
 * sempre — a cor vira reconhecimento na lista, não enfeite. Paleta fechada em
 * 8 matizes espaçados; nada de hue aleatório.
 */
const AVATAR_HUES = [15, 45, 95, 150, 190, 230, 280, 330];
function avatarHue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 9973;
  return AVATAR_HUES[h % AVATAR_HUES.length]!;
}

function initials(name: string | null | undefined, fallback: string): string {
  const v = (name ?? "").trim();
  if (!v) return fallback.slice(0, 2).toUpperCase();
  const parts = v.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return fallback.slice(0, 2).toUpperCase();
  if (parts.length === 1) return (parts[0] ?? "").slice(0, 2).toUpperCase();
  const first = parts[0]?.[0] ?? "";
  const last = parts[parts.length - 1]?.[0] ?? "";
  return (first + last).toUpperCase();
}

function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return format(d, "HH:mm");
  const diff = (now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24);
  if (diff < 7) return formatDistanceToNowStrict(d, { addSuffix: false, locale: ptBR });
  return format(d, "dd/MM");
}

export function ConversationListItem({ conversation, isSelected, onSelect }: Props) {
  const c = conversation.contacts ?? null;
  const displayName = c?.display_name?.trim() || c?.name?.trim() || c?.phone_number || "Sem nome";
  const phoneFallback = c?.phone_number ?? "??";
  const tags = c?.tags ?? [];
  const visibleTags = tags.slice(0, 2);
  const overflow = tags.length - visibleTags.length;
  const preview = conversation.last_message_preview?.trim() || "Sem mensagens";
  const truncated = preview.length > 60 ? `${preview.slice(0, 60)}…` : preview;
  const time = relativeTime(conversation.last_message_at);
  const unread = conversation.unread_count_for_assignee ?? 0;
  const dot = STATUS_DOT[conversation.status] ?? STATUS_DOT.open;
  const isAi = conversation.status === "ai_handling";

  return (
    <button
      type="button"
      onClick={() => onSelect(conversation.id)}
      className={cn(
        "group flex w-full items-start gap-3 border-b border-border px-3 py-3 text-left",
        "transition-colors duration-fast ease-out hover:bg-surface-muted",
        // Selecionada: lavada no accent (sem tarja lateral), texto no tom
        // escuro do próprio accent p/ manter contraste alto.
        isSelected && "bg-accent-soft hover:bg-accent-soft",
      )}
      aria-current={isSelected ? "true" : undefined}
    >
      <div className="relative shrink-0">
        <Avatar className="h-10 w-10">
          <AvatarFallback
            className="avatar-tint text-xs font-semibold"
            style={{ "--tint-h": avatarHue(c?.id ?? displayName) } as CSSProperties}
          >
            {initials(displayName, phoneFallback)}
          </AvatarFallback>
        </Avatar>
        <span
          className={cn(
            "absolute -right-0.5 -top-0.5 size-2.5 rounded-full ring-2 ring-surface",
            dot,
          )}
          aria-hidden
        />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span
            className={cn(
              "truncate text-sm text-text",
              // Não lida pesa mais: nome em semibold, prévia em texto cheio.
              unread > 0 ? "font-semibold" : "font-medium",
              c?.is_anonymized && "italic text-text-subtle",
            )}
          >
            {displayName}
          </span>
          <span
            className={cn(
              "shrink-0 text-[10px] uppercase tracking-wide",
              unread > 0 ? "font-semibold text-accent" : "text-text-subtle",
            )}
          >
            {time}
          </span>
        </div>

        <p
          className={cn(
            "mt-0.5 truncate text-xs",
            unread > 0 ? "text-text-muted" : "text-text-subtle",
          )}
        >
          {isAi ? <Robot size={10} weight="duotone" className="mr-1 inline" aria-hidden /> : null}
          {truncated}
        </p>

        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {visibleTags.map((t) => (
            <Badge key={t} variant="secondary" className="h-4 px-1.5 text-[10px]">
              {t}
            </Badge>
          ))}
          {overflow > 0 && <span className="text-[10px] text-muted-foreground">+{overflow}</span>}
          {c?.is_blocked && (
            <Badge variant="destructive" className="h-4 px-1.5 text-[10px]">
              Bloqueado
            </Badge>
          )}
          {c?.is_anonymized && (
            <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
              Anonimizado
            </Badge>
          )}
          {unread > 0 && (
            <span className="text-accent-fg ml-auto inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent px-1.5 text-[10px] font-semibold tabular-nums">
              {unread}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}
