"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";
import { createClient } from "@/lib/supabase/browser";
import type { BoardData, Pipeline, Stage } from "@/lib/kanban/types";
import type { Lead } from "@/lib/types/leads";

async function fetchBoard(pipelineId: string): Promise<BoardData> {
  const supabase = createClient();
  const [
    { data: pipeline, error: pipelineErr },
    { data: stages, error: stagesErr },
    { data: leads, error: leadsErr },
  ] = await Promise.all([
    supabase.from("crm_pipelines").select("*").eq("id", pipelineId).single(),
    supabase
      .from("crm_stages")
      .select("*")
      .eq("pipeline_id", pipelineId)
      .eq("is_archived", false)
      .order("position"),
    supabase
      .from("crm_leads")
      .select("*")
      .eq("pipeline_id", pipelineId)
      .neq("status", "archived")
      .order("position_in_stage"),
  ]);
  if (pipelineErr) throw pipelineErr;
  if (stagesErr) throw stagesErr;
  if (leadsErr) throw leadsErr;
  return {
    pipeline: pipeline as Pipeline,
    stages: (stages ?? []) as Stage[],
    leads: (leads ?? []) as Lead[],
  };
}

export function useBoard(pipelineId: string | null) {
  const qc = useQueryClient();
  const queryKey = ["board", pipelineId] as const;

  const query = useQuery({
    queryKey,
    queryFn: () => fetchBoard(pipelineId as string),
    enabled: !!pipelineId,
  });

  const onChange = useCallback(() => {
    // Conservative: invalidate the board on any change. Optimistic patches
    // arrive faster via useMoveCard's onMutate; this just reconciles
    // cross-user changes within ~250ms.
    qc.invalidateQueries({ queryKey });
  }, [qc, queryKey]);

  useRealtimeChannel({
    name: pipelineId ? `kanban-${pipelineId}` : "kanban-disabled",
    postgresChanges: pipelineId
      ? {
          event: "*",
          schema: "public",
          table: "crm_leads",
          filter: `pipeline_id=eq.${pipelineId}`,
        }
      : undefined,
    onChange,
    enabled: !!pipelineId,
  });

  return query;
}
