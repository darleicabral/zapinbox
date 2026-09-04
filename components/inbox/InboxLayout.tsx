"use client";
import { useCallback, useMemo, useRef, useState } from "react";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { ChatCircle } from "@/lib/ui/icons";
import { hasPosvendaModule } from "@/lib/modules";
import { useClaimConversation } from "@/hooks/inbox/useClaimConversation";
import { useCloseConversation } from "@/hooks/inbox/useCloseConversation";
import {
  useConversationsRealtime,
  type ConversationsFilters,
  type ConversationWithContact,
} from "@/hooks/inbox/useConversationsRealtime";
import { ConversationList } from "./ConversationList";
import { InboxFilters, type InboxFiltersValue } from "./InboxFilters";
import { ChatThread } from "./ChatThread";
import { Composer, type ComposerHandle } from "./Composer";
import { ConversationHeader } from "./ConversationHeader";
import { CRMSidePanel } from "./CRMSidePanel";
import { InboxKeyboardShortcuts } from "./InboxKeyboardShortcuts";
import { ShortcutsHelpDialog } from "./ShortcutsHelpDialog";

function tabToFilter(tab: InboxFiltersValue["tab"]): Partial<ConversationsFilters> {
  switch (tab) {
    case "unassigned":
      return { assigned_to: "unassigned", status: "open" };
    case "mine":
      return { assigned_to: "me" };
    case "open":
      // "Mensagens" = fila de trabalho: tudo que não foi fechado/arquivado.
      return { exclude_status: ["closed", "archived"] };
    case "closed":
      return { status: "closed" };
    case "ai":
      return { status: "ai_handling" };
    case "all":
    default:
      return {};
  }
}

interface InboxLayoutProps {
  initialSelectedId?: string | null;
}

export function InboxLayout({ initialSelectedId = null }: InboxLayoutProps = {}) {
  const { activeOrg } = useAuth();
  const orgId = activeOrg?.orgId ?? null;

  // Pós-venda (atendente único) abre direto em "Mensagens"; CORRETOR abre em
  // "Meus", que é a única lista dele (decisão do Darlei, 04/09/2026); os demais
  // seguem em "Não atribuídos". Escolher aqui evita o primeiro fetch numa aba
  // que nem existe pro papel (o InboxFilters corrige depois, com 1 ida à toa).
  const [filterValue, setFilterValue] = useState<InboxFiltersValue>({
    tab: hasPosvendaModule(activeOrg?.orgId)
      ? "open"
      : activeOrg?.role === "agent"
        ? "mine"
        : "unassigned",
    search: "",
    onlyUnread: false,
  });
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId);
  const [visibleIds, setVisibleIds] = useState<string[]>([]);
  const [helpOpen, setHelpOpen] = useState(false);
  const composerRef = useRef<ComposerHandle | null>(null);

  const filters: ConversationsFilters = useMemo(
    () => ({
      ...tabToFilter(filterValue.tab),
      search: filterValue.search || undefined,
      channel_session_id: filterValue.channel_session_id,
    }),
    [filterValue.tab, filterValue.search, filterValue.channel_session_id],
  );

  const clientFilter = useMemo(
    () =>
      filterValue.onlyUnread
        ? (c: ConversationWithContact) => (c.unread_count_for_assignee ?? 0) > 0
        : undefined,
    [filterValue.onlyUnread],
  );

  // We need the selected conversation object for header / composer / side panel.
  // Source it from the same query the list uses to avoid an extra request.
  const listQ = useConversationsRealtime(filters, orgId);
  const selectedConversation: ConversationWithContact | null = useMemo(() => {
    const all = listQ.data?.pages.flatMap((p) => p.data) ?? [];
    return all.find((c) => c.id === selectedId) ?? null;
  }, [listQ.data, selectedId]);

  const claim = useClaimConversation();
  const close = useCloseConversation();

  const handleSelect = useCallback((id: string) => setSelectedId(id), []);
  const handleVisibleChange = useCallback((ids: string[]) => setVisibleIds(ids), []);
  const handleFocusReply = useCallback(() => composerRef.current?.focus(), []);
  const handleClaim = useCallback(() => {
    if (!selectedConversation) return;
    claim.mutate({
      conversation_id: selectedConversation.id,
      expected_assignee: selectedConversation.assigned_to_user_id,
    });
  }, [claim, selectedConversation]);
  const handleClose = useCallback(() => {
    if (!selectedConversation) return;
    close.mutate({ conversation_id: selectedConversation.id });
  }, [close, selectedConversation]);

  const blockedReason = selectedConversation?.contacts?.is_blocked
    ? "Contato bloqueado — envio de mensagens desabilitado."
    : selectedConversation?.contacts?.is_anonymized
      ? "Contato anonimizado — não é possível enviar mensagens."
      : null;

  // Altura = viewport − TopBar (h-14 = 3.5rem) − padding do <main> do AppShell
  // (p-6 em cima e embaixo = 3rem). Sem descontar o padding, o composer ficava
  // 48px abaixo da dobra e só aparecia rolando a página.
  return (
    <div className="grid h-[calc(100vh-6.5rem)] w-full grid-cols-1 overflow-hidden rounded-xl border border-border bg-bg shadow-sm md:grid-cols-[320px_1fr] xl:grid-cols-[320px_1fr_320px]">
      {/* Três zonas com tons distintos: lista (branco), conversa (canvas
          rebaixado, p/ os balões virarem objetos) e ficha (trilho). */}
      <div className="flex h-full min-h-0 flex-col border-r border-border bg-surface">
        <InboxFilters value={filterValue} onChange={setFilterValue} />
        <div className="min-h-0 flex-1 overflow-hidden">
          <ConversationList
            filters={filters}
            orgId={orgId}
            selectedId={selectedId}
            onSelect={handleSelect}
            clientFilter={clientFilter}
            onVisibleChange={handleVisibleChange}
          />
        </div>
      </div>

      <div className="flex h-full min-h-0 flex-col bg-bg">
        {selectedConversation ? (
          <>
            <ConversationHeader conversation={selectedConversation} />
            <div className="min-h-0 flex-1 overflow-hidden">
              <ChatThread conversationId={selectedConversation.id} />
            </div>
            <Composer
              ref={composerRef}
              conversationId={selectedConversation.id}
              blockedReason={blockedReason}
              disabled={selectedConversation.status === "closed"}
            />
          </>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-surface text-text-subtle shadow-xs">
              <ChatCircle size={22} weight="duotone" aria-hidden />
            </span>
            <div>
              <p className="text-sm font-medium text-text">Nenhuma conversa selecionada</p>
              <p className="mt-0.5 text-xs text-text-subtle">
                Escolha alguém na lista ao lado para ler e responder.
              </p>
            </div>
          </div>
        )}
      </div>

      <div className="hidden h-full min-h-0 xl:block">
        <CRMSidePanel conversation={selectedConversation} />
      </div>

      <InboxKeyboardShortcuts
        visibleIds={visibleIds}
        selectedId={selectedId}
        onSelect={handleSelect}
        onFocusReply={handleFocusReply}
        onClaim={handleClaim}
        onClose={handleClose}
        onToggleHelp={() => setHelpOpen((v) => !v)}
      />
      <ShortcutsHelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
    </div>
  );
}
