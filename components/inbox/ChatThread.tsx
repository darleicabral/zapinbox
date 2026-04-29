"use client";
import { useEffect, useMemo, useRef } from "react";
import { format, isToday, isYesterday } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { MessageBubble } from "./MessageBubble";
import { useMessagesRealtime } from "@/hooks/inbox/useMessagesRealtime";
import { useDebugToggle } from "@/hooks/ai/useDebugToggle";
import { useActiveOrg } from "@/hooks/auth/AuthProvider";
import type { Message } from "@/lib/types/messaging";

interface Props {
  conversationId: string | null;
}

function dayLabel(d: Date): string {
  if (isToday(d)) return "Hoje";
  if (isYesterday(d)) return "Ontem";
  return format(d, "dd/MM/yyyy", { locale: ptBR });
}

export function ChatThread({ conversationId }: Props) {
  const q = useMessagesRealtime(conversationId);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const activeOrg = useActiveOrg();
  const { enabled: debugCitations } = useDebugToggle(activeOrg?.role ?? null);

  const messages: Message[] = useMemo(
    () => q.data?.pages.flatMap((p) => p.data) ?? [],
    [q.data],
  );

  // Scroll to bottom on first load + new message arrival.
  useEffect(() => {
    if (!bottomRef.current) return;
    bottomRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, conversationId]);

  if (!conversationId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Selecione uma conversa
      </div>
    );
  }

  if (q.isLoading) {
    return (
      <div className="space-y-3 p-4">
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-12 w-2/3" />
        ))}
      </div>
    );
  }

  if (q.isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
        <p>Erro ao carregar mensagens.</p>
        <Button size="sm" variant="outline" onClick={() => q.refetch()}>
          Tentar novamente
        </Button>
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Nenhuma mensagem nesta conversa.
      </div>
    );
  }

  // Group by day for separators.
  const groups: { key: string; date: Date; items: Message[] }[] = [];
  for (const m of messages) {
    const d = new Date(m.sent_at);
    const key = format(d, "yyyy-MM-dd");
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(m);
    else groups.push({ key, date: d, items: [m] });
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto py-2">
        {q.hasNextPage && (
          <div className="flex justify-center py-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => q.fetchNextPage()}
              disabled={q.isFetchingNextPage}
            >
              {q.isFetchingNextPage ? "Carregando…" : "Carregar mais antigas"}
            </Button>
          </div>
        )}

        {groups.map((g) => (
          <div key={g.key} className="space-y-1">
            <div className="sticky top-0 z-10 flex justify-center py-1">
              <span className="rounded-full bg-background/80 px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground backdrop-blur">
                {dayLabel(g.date)}
              </span>
            </div>
            {g.items.map((m) => (
              <MessageBubble
                key={m.id}
                message={m}
                debugCitations={debugCitations}
              />
            ))}
          </div>
        ))}

        <div ref={bottomRef} />
      </div>
    </div>
  );
}
