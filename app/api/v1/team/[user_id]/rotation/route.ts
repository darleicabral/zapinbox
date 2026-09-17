/**
 * PATCH /api/v1/team/[user_id]/rotation — pausa/reativa o membro no rodízio de
 * leads (folga). Gerente pra cima.
 *
 * Body: { paused_until: string | null }
 *   - ISO no futuro  → membro fica FORA da roleta até essa data (não recebe lead
 *     novo). Expira sozinho: passou a data, volta ao rodízio sem ninguém mexer.
 *   - null           → reativa já.
 *
 * Diferente de rebaixar papel ou revogar: não mexe no acesso do corretor, ele só
 * para de receber lead novo. Os leads que já estão com ele continuam com ele.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { canManageTeam } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  paused_until: z
    .string()
    .datetime({ message: "Use uma data ISO 8601, ex.: 2026-09-21T00:00:00.000Z." })
    .nullable(),
});

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ user_id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { user_id: targetUserId } = await ctx.params;

  const authUser = await loadAuthUser();
  if (!authUser) return fail("unauthenticated", "Auth required.", 401, { requestId });
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) return fail("forbidden_tenant", "Sem organização ativa.", 403, { requestId });
  if (!canManageTeam(activeOrg.role)) {
    return fail("forbidden_role", "Apenas gestores podem pausar corretores da roleta.", 403, {
      requestId,
    });
  }

  let input: z.infer<typeof bodySchema>;
  try {
    input = bodySchema.parse(await req.json());
  } catch (err) {
    const msg =
      err instanceof z.ZodError ? (err.issues[0]?.message ?? "inválido") : "Body inválido.";
    return fail("validation_failed", msg, 422, { requestId });
  }

  const supabase = await createClient();
  const { data: target, error: fetchErr } = await supabase
    .from("user_organizations")
    .select("id, user_id, revoked_at")
    .eq("organization_id", activeOrg.orgId)
    .eq("user_id", targetUserId)
    .maybeSingle();
  if (fetchErr) return fail("internal_error", fetchErr.message, 500, { requestId });
  if (!target) return fail("not_found", "Membro não encontrado.", 404, { requestId });
  if (target.revoked_at) return fail("state_conflict", "Membro está revogado.", 409, { requestId });

  const { error: updErr } = await supabase
    .from("user_organizations")
    .update({
      rotation_paused_until: input.paused_until,
      updated_at: new Date().toISOString(),
    })
    .eq("id", target.id);
  if (updErr) return fail("internal_error", updErr.message, 500, { requestId });

  await audit({
    action: "member.rotation_paused",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "membership",
    resourceId: target.id,
    requestId,
    metadata: { target_user_id: targetUserId, paused_until: input.paused_until },
  });

  return ok({ user_id: targetUserId, rotation_paused_until: input.paused_until }, { requestId });
}
