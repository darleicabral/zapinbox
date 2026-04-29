/**
 * POST /api/v1/ai/knowledge/sources/:id/reindex
 *
 * Marca uma knowledge source como `pending` (otimista) e emite o evento
 * `knowledge_source.updated` para o worker re-processar a fonte.
 *
 * Auth: cookie session, role >= manager.
 * organization_id é resolvido do JWT — nunca do body/path.
 */

import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";
import { ok, fail } from "@/lib/api/wrappers";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const reindexBodySchema = z
  .object({
    force: z.boolean().optional(),
  })
  .partial()
  .optional();

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await params;

  const authUser = await loadAuthUser();
  if (!authUser) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) {
    return fail("forbidden", "Nenhuma organização ativa.", 403, { requestId });
  }
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    return fail("forbidden_role", "Permissão insuficiente. Requer role >= manager.", 403, {
      requestId,
    });
  }

  // Body é opcional; se vier, valida.
  if (req.headers.get("content-length") && req.headers.get("content-length") !== "0") {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      raw = undefined;
    }
    if (raw !== undefined && raw !== null) {
      const parsed = reindexBodySchema.safeParse(raw);
      if (!parsed.success) {
        return fail("validation_failed", "Campos inválidos.", 422, {
          requestId,
          details: parsed.error.flatten(),
        });
      }
    }
  }

  // Valida ownership via cliente user-scoped (RLS).
  const supabase = await createClient();
  const { data: existing, error: fetchErr } = await supabase
    .from("ai_knowledge_sources")
    .select("id, agent_id, source_type")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();

  if (fetchErr) {
    console.error("[ai-knowledge-reindex] fetch failed:", fetchErr.message);
    return fail("internal_error", "Erro ao verificar fonte.", 500, { requestId });
  }
  if (!existing) {
    return fail("not_found", "Fonte de conhecimento não encontrada.", 404, { requestId });
  }

  const ksRow = existing as { id: string; agent_id: string; source_type: string };

  const admin = createAdminClient();

  const { error: updateErr } = await admin
    .from("ai_knowledge_sources")
    .update({ last_index_status: "pending", last_index_error: null })
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId);

  if (updateErr) {
    console.error("[ai-knowledge-reindex] update failed:", updateErr.message);
    return fail("internal_error", "Erro ao marcar fonte para re-indexação.", 500, { requestId });
  }

  // Emit knowledge_source.updated (fire-and-forget).
  const { error: emitErr } = await admin.rpc("emit_event" as never, {
    p_event_type: "knowledge_source.updated",
    p_entity_kind: "ai_knowledge_source",
    p_entity_id: id,
    p_payload: {
      knowledge_source_id: id,
      agent_id: ksRow.agent_id,
      source_type: ksRow.source_type,
      triggered_by: "manual_reindex",
    },
    p_organization_id: activeOrg.orgId,
  } as never);

  if (emitErr) {
    console.warn("[ai-knowledge-reindex] emit_event failed (non-blocking):", emitErr.message);
  }

  return ok({ id, last_index_status: "pending" as const }, { requestId });
}
