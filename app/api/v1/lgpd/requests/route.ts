/**
 * GET /api/v1/lgpd/requests
 *
 * Lista paginada de lgpd_requests para o tenant ativo.
 * Apenas role >= admin pode acessar (lgpd:execute permission).
 * organization_id sempre resolvido de sessão confiável — nunca do body.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  status: z.enum(["received", "processing", "completed", "failed", "pending_review"]).optional(),
  type: z.enum(["customer_redact", "customer_data_request", "store_redact"]).optional(),
  sla_bucket: z.enum(["overdue", "critical", "warning", "ok"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

type SlaBucket = "overdue" | "critical" | "warning" | "ok";

function computeSlaBucket(dueAt: string | null, receivedAt: string): SlaBucket {
  if (!dueAt) return "ok";
  const now = Date.now();
  const due = new Date(dueAt).getTime();
  const received = new Date(receivedAt).getTime();
  const msUntilDue = due - now;

  if (msUntilDue < 0) return "overdue";
  if (msUntilDue < 2 * 24 * 60 * 60 * 1000) return "critical";
  const totalWindow = due - received;
  if (totalWindow > 0 && msUntilDue < totalWindow * 0.5) return "warning";
  return "ok";
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const supabase = await createClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }

  const authUser = await loadAuthUser();
  if (!authUser) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }

  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) {
    return fail("forbidden_tenant", "Nenhuma organização ativa.", 403, { requestId });
  }

  // Permission: role >= admin OR platform_admin
  const isAllowed = authUser.is_platform_admin || ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager;
  if (!isAllowed) {
    return fail("forbidden_role", "Apenas administradores podem acessar solicitações LGPD.", 403, {
      requestId,
    });
  }

  // Parse + validate query params
  const rawParams: Record<string, string> = {};
  req.nextUrl.searchParams.forEach((v, k) => {
    rawParams[k] = v;
  });
  const parsed = querySchema.safeParse(rawParams);
  if (!parsed.success) {
    return fail("validation_failed", "Parâmetros inválidos.", 422, {
      details: parsed.error.flatten(),
      requestId,
    });
  }
  const { status, type, page, limit } = parsed.data;

  const orgId = activeOrg.orgId;
  const offset = (page - 1) * limit;

  // Count query (before sla_bucket filter which is client-side)
  let countQuery = supabase
    .from("lgpd_requests")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId);
  if (status) countQuery = countQuery.eq("status", status);
  if (type) countQuery = countQuery.eq("request_type", type);
  const { count } = await countQuery;
  const total = count ?? 0;

  // Data query
  let dataQuery = supabase
    .from("lgpd_requests")
    .select(
      "id, organization_id, request_type, source, contact_id, external_customer_id, status, attempts, received_at, due_at, completed_at, emergency, scope, error_message",
    )
    .eq("organization_id", orgId)
    .order("due_at", { ascending: true, nullsFirst: false })
    .order("received_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) dataQuery = dataQuery.eq("status", status);
  if (type) dataQuery = dataQuery.eq("request_type", type);

  const { data: rows, error: dbErr } = await dataQuery;
  if (dbErr) {
    return fail("internal_error", dbErr.message, 500, { requestId });
  }

  // Compute sla_bucket per row and apply optional filter
  const enriched = (rows ?? []).map((r) => ({
    ...r,
    sla_bucket: computeSlaBucket(r.due_at, r.received_at),
  }));

  const filtered = parsed.data.sla_bucket
    ? enriched.filter((r) => r.sla_bucket === parsed.data.sla_bucket)
    : enriched;

  return ok(filtered, {
    requestId,
    meta: {
      total,
      page,
      limit,
      has_more: offset + limit < total,
    },
  });
}
