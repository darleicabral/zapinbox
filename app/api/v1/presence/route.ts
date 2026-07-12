/**
 * POST /api/v1/presence — heartbeat de presença do atendente (C4).
 *
 * Body: { organization_id: uuid, presence?: 'online' | 'busy' | 'offline' }
 * (default 'online'). O componente <PresenceHeartbeat> chama a cada 60s com a
 * aba aberta; o rodízio considera online quem tem presence='online' E heartbeat
 * fresco (PRESENCE_FRESH_MS em lib/attendance/rotation.ts) — auto-offline por
 * staleness, sem cron.
 *
 * Escrita via admin client após validar via getUser() que o caller é membro
 * ativo da org (RLS de user_organizations não prevê update de presence).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  organization_id: z.string().uuid(),
  presence: z.enum(["online", "busy", "offline"]).default("online"),
});

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const supabase = await createClient();

  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }

  let body;
  try {
    body = bodySchema.parse(await req.json());
  } catch {
    return fail("invalid_request", "organization_id (uuid) obrigatório.", 422, { requestId });
  }

  const admin = createAdminClient();
  const { data: membership } = await admin
    .from("user_organizations")
    .select("user_id")
    .eq("organization_id", body.organization_id)
    .eq("user_id", user.id)
    .is("revoked_at", null)
    .maybeSingle();
  if (!membership) {
    return fail("forbidden", "Not a member of this organization.", 403, { requestId });
  }

  const { error: updErr } = await admin
    .from("user_organizations")
    .update({ presence: body.presence, presence_updated_at: new Date().toISOString() })
    .eq("organization_id", body.organization_id)
    .eq("user_id", user.id);
  if (updErr) {
    return fail("internal_error", updErr.message, 500, { requestId });
  }

  return ok({ presence: body.presence }, { requestId, meta: { requestId } });
}
