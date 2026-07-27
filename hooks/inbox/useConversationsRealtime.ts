"use client";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { Conversation } from "@/lib/types/messaging";

export interface ContactSummary {
  id: string;
  display_name: string | null;
  name: string | null;
  phone_number: string | null;
  tags: string[];
  is_blocked: boolean;
  is_anonymized: boolean;
}

export type ConversationWithContact = Conversation & {
  contacts?: ContactSummary | null;
};

export type ConversationStatus = "open" | "claimed" | "ai_handling" | "closed" | "archived";

export interface ConversationsFilters {
  status?: ConversationStatus;
  /** Nega os status listados (aba "Mensagens" = tudo que não está fechado). */
  exclude_status?: ConversationStatus[];
  assigned_to?: "me" | "unassigned" | string;
  search?: string;
  channel_session_id?: string;
}

interface ListResponse {
  data: ConversationWithContact[];
  meta?: { cursor?: string | null; has_more?: boolean };
}

export function useConversationsRealtime(filters: ConversationsFilters, orgId: string | null) {
  const qc = useQueryClient();
  const queryKey = ["conversations", filters] as const;

  const query = useInfiniteQuery({
    queryKey,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const qs = new URLSearchParams();
      if (filters.status) qs.set("status", filters.status);
      if (filters.exclude_status?.length) {
        qs.set("exclude_status", filters.exclude_status.join(","));
      }
      if (filters.assigned_to) qs.set("assigned_to", filters.assigned_to);
      if (filters.search) qs.set("search", filters.search);
      if (filters.channel_session_id) qs.set("channel_session_id", filters.channel_session_id);
      if (pageParam) qs.set("cursor", pageParam);
      qs.set("limit", "50");
      try {
        return await apiClient.get<ListResponse>(`/api/v1/conversations?${qs.toString()}`);
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
    getNextPageParam: (last) =>
      last.meta?.has_more && last.meta.cursor ? last.meta.cursor : undefined,
  });

  const onChange = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["conversations"] });
  }, [qc]);

  useRealtimeChannel({
    name: orgId ? `inbox-${orgId}` : "inbox-disabled",
    postgresChanges: orgId
      ? {
          event: "*",
          schema: "public",
          table: "conversations",
          filter: `organization_id=eq.${orgId}`,
        }
      : undefined,
    onChange,
    enabled: !!orgId,
  });

  return query;
}
