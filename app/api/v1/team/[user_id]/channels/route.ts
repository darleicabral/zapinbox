/**
 * PATCH /api/v1/team/[user_id]/channels — define QUAIS números de WhatsApp o
 * membro vê (0029). Gerente pra cima; gerente não mexe em admin.
 *
 * Body: { channel_session_ids: string[] }
 *   - lista vazia  = **sem restrição** (o membro vê todos os números). É o
 *     estado de todo mundo hoje, e é o default de compatibilidade da 0029.
 *   - lista cheia  = vê só esses.
 *
 * Semântica de SUBSTITUIÇÃO: o que não vier na lista é removido. Assim a tela
 * manda o estado final e não precisa calcular diferenças.
 *
 * ⚠️ Atribuir número a gerente/admin não muda nada: `fn_user_session_ids()` dá
 * todos os números pra eles por papel. A tela avisa isso.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { canManageMember, canManageTeam } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import type { Role } from "@/lib/auth/types";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  channel_session_ids: z.array(z.string().uuid()).max(20),
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
    return fail("forbidden_role", "Apenas gerentes e admins podem definir números.", 403, {
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
    .select("id, user_id, role, revoked_at")
    .eq("organization_id", activeOrg.orgId)
    .eq("user_id", targetUserId)
    .maybeSingle();
  if (fetchErr) return fail("internal_error", fetchErr.message, 500, { requestId });
  if (!target) return fail("not_found", "Membro não encontrado.", 404, { requestId });
  if (target.revoked_at) return fail("state_conflict", "Membro está revogado.", 409, { requestId });
  if (!canManageMember(activeOrg.role as Role, target.role as Role)) {
    return fail("forbidden_role", "Gerente não altera administrador.", 403, { requestId });
  }

  const ids = Array.from(new Set(input.channel_session_ids));

  // Os números têm de ser da org (e visíveis a quem está atribuindo — a RLS de
  // channel_sessions já garante as duas coisas).
  if (ids.length > 0) {
    const { data: valid, error: chErr } = await supabase
      .from("channel_sessions")
      .select("id")
      .eq("organization_id", activeOrg.orgId)
      .in("id", ids);
    if (chErr) return fail("internal_error", chErr.message, 500, { requestId });
    if ((valid ?? []).length !== ids.length) {
      return fail("validation_failed", "Número de WhatsApp inválido para esta empresa.", 422, {
        requestId,
      });
    }
  }

  // Substituição: apaga o que saiu, insere o que entrou.
  const { error: delErr } = await supabase
    .from("user_channel_sessions")
    .delete()
    .eq("organization_id", activeOrg.orgId)
    .eq("user_id", targetUserId);
  if (delErr) return fail("internal_error", delErr.message, 500, { requestId });

  if (ids.length > 0) {
    const { error: insErr } = await supabase.from("user_channel_sessions").insert(
      ids.map((id) => ({
        organization_id: activeOrg.orgId,
        user_id: targetUserId,
        channel_session_id: id,
        created_by: authUser.id,
      })),
    );
    if (insErr) return fail("internal_error", insErr.message, 500, { requestId });
  }

  await audit({
    action: "member.channels_changed",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "membership",
    resourceId: target.id,
    requestId,
    metadata: {
      target_user_id: targetUserId,
      channel_session_ids: ids,
      // lista vazia = liberou todos os números (não é "tirou tudo")
      unrestricted: ids.length === 0,
    },
  });

  return ok({ user_id: targetUserId, channel_session_ids: ids }, { requestId });
}
