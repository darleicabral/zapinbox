"use client";
/**
 * Aviso de mensagem nova enquanto o CRM está aberto — o comportamento do
 * WhatsApp Web: toca um som, mostra a notificação do sistema e coloca o contador
 * no título da aba, UMA por mensagem recebida (sem agrupar, sem throttle).
 *
 * Complementa (não substitui) o push do servidor em `lib/waha/ingest.ts`, que é
 * quem avisa no celular quando o CRM está fechado.
 *
 * Regras de silêncio, iguais às do WhatsApp Web:
 *  - só mensagem RECEBIDA (inbound);
 *  - se a aba está visível E a conversa já está aberta na tela, não avisa.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";

import { useActiveOrg } from "@/hooks/auth/AuthProvider";
import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";

interface MessageRow {
  id: string;
  conversation_id: string;
  direction: string;
  body: string | null;
  type: string;
}

const MEDIA_LABEL: Record<string, string> = {
  image: "📷 Imagem",
  audio: "🎤 Áudio",
  video: "🎬 Vídeo",
  document: "📄 Documento",
  sticker: "Figurinha",
  location: "📍 Localização",
  contact: "Contato",
};

/**
 * "Ding" sintetizado na hora (duas notas curtas) — evita carregar um .mp3 só
 * pra isso. O AudioContext nasce suspenso até o primeiro clique do usuário;
 * `unlock()` cuida disso.
 */
function useNotificationSound() {
  const ctxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    const unlock = () => {
      if (ctxRef.current) return;
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      ctxRef.current = new Ctor();
    };
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  return useCallback(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    if (ctx.state === "suspended") void ctx.resume();
    const now = ctx.currentTime;
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.09, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.42);
    for (const [freq, at] of [
      [880, 0],
      [1174.7, 0.11],
    ] as const) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, now + at);
      osc.connect(gain);
      osc.start(now + at);
      osc.stop(now + at + 0.3);
    }
  }, []);
}

export function MessageNotifier() {
  const router = useRouter();
  const organizationId = useActiveOrg()?.orgId ?? null;
  const qc = useQueryClient();
  const play = useNotificationSound();

  const [unread, setUnread] = useState(0);
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(
    "unsupported",
  );

  /**
   * Conversa aberta AGORA. Lido da URL na hora do evento (e não por
   * `useSearchParams`) pra não exigir Suspense no shell inteiro.
   */
  const openConversationId = useCallback((): string | null => {
    const { pathname, search } = window.location;
    if (pathname === "/app/inbox") return new URLSearchParams(search).get("id");
    if (pathname.startsWith("/app/inbox/")) return pathname.split("/")[3] ?? null;
    return null;
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined" && "Notification" in window) {
      setPermission(Notification.permission);
    }
  }, []);

  // Contador no título — some ao voltar pra aba, como no WhatsApp Web.
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\)\s*/, "");
    document.title = unread > 0 ? `(${unread}) ${base}` : base;
  }, [unread]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") setUnread(0);
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);

  /** Nome do contato pelo cache das conversas; sem cache, cai no genérico. */
  const senderName = useCallback(
    (conversationId: string): string | null => {
      const entries = qc.getQueriesData<{ pages?: Array<{ data: ConversationWithContact[] }> }>({
        queryKey: ["conversations"],
      });
      for (const [, value] of entries) {
        for (const page of value?.pages ?? []) {
          const hit = page.data.find((c) => c.id === conversationId);
          if (hit) {
            return (
              hit.contacts?.display_name?.trim() ||
              hit.contacts?.name?.trim() ||
              hit.contacts?.phone_number ||
              null
            );
          }
        }
      }
      return null;
    },
    [qc],
  );

  const onChange = useCallback(
    (payload: unknown) => {
      const row = (payload as { new?: MessageRow })?.new;
      if (!row || row.direction !== "inbound") return;

      const isOpenHere =
        document.visibilityState === "visible" && openConversationId() === row.conversation_id;
      if (isOpenHere) return;

      if (document.visibilityState !== "visible") setUnread((n) => n + 1);
      play();

      if (typeof window === "undefined" || !("Notification" in window)) return;
      if (Notification.permission !== "granted") return;
      const who = senderName(row.conversation_id);
      const preview = row.body?.trim() || MEDIA_LABEL[row.type] || "Nova mensagem";
      const n = new Notification(who ? `${who}` : "Nova mensagem", {
        body: preview.slice(0, 140),
        tag: `conv-${row.conversation_id}`, // uma notificação por conversa na bandeja
        icon: "/icon-192.png",
        silent: true, // o som é nosso, evita tocar dois
      });
      n.onclick = () => {
        window.focus();
        router.push(`/app/inbox?id=${row.conversation_id}`);
        n.close();
      };
    },
    [openConversationId, play, router, senderName],
  );

  useRealtimeChannel({
    name: organizationId ? `notify-${organizationId}` : "notify-disabled",
    postgresChanges: organizationId
      ? {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `organization_id=eq.${organizationId}`,
        }
      : undefined,
    onChange,
    enabled: !!organizationId,
  });

  if (permission !== "default") return null;

  // Flutuante de propósito: fora do fluxo, não empurra a altura de nenhuma
  // tela (o Inbox depende da altura exata do shell).
  return (
    <div className="fixed bottom-4 right-4 z-toast flex max-w-xs items-center gap-3 rounded-xl border border-border bg-surface p-3 text-xs text-text shadow-lg">
      <span className="leading-snug">
        Quer ser avisado de cada mensagem nova, com som, mesmo em outra aba?
      </span>
      <button
        type="button"
        className="text-accent-fg shrink-0 rounded-md bg-accent px-2.5 py-1.5 font-medium transition-colors duration-fast ease-out hover:bg-accent-hover"
        onClick={() => {
          void Notification.requestPermission().then(setPermission);
        }}
      >
        Ativar
      </button>
    </div>
  );
}
