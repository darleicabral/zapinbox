/**
 * PATCH /api/v1/team/[user_id]/notify-phone — define/limpa o número de WhatsApp
 * do membro para receber avisos de novo lead (C4). Admin-only.
 *
 * Body: { notify_whatsapp_e164: string | null }  (E.164, ex. "+5531999998888";
 * null/"" limpa e desativa a notificação pra esse membro).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  notify_whatsapp_e164: z
    .string()
    .trim()
    .regex(/^\+[1-9][0-9]{7,14}$/, "Use o formato internacional, ex.: +5531999998888.")
    .nullable()
    .or(z.literal("").transform(() => null)),
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
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    return fail("forbidden_role", "Apenas admins podem definir o WhatsApp de notificação.", 403, {
      requestId,
    });
  }

  let input: z.infer<typeof bodySchema>;
  try {
    input = bodySchema.parse(await req.json());
  } catch (err) {
    const msg = err instanceof z.ZodError ? (err.issues[0]?.message ?? "inválido") : "Body inválido.";
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
    .update({ notify_whatsapp_e164: input.notify_whatsapp_e164, updated_at: new Date().toISOString() })
    .eq("id", target.id);
  if (updErr) return fail("internal_error", updErr.message, 500, { requestId });

  await audit({
    action: "member.notify_phone_changed",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "membership",
    resourceId: target.id,
    requestId,
    metadata: { target_user_id: targetUserId, has_phone: input.notify_whatsapp_e164 !== null },
  });

  return ok(
    { user_id: targetUserId, notify_whatsapp_e164: input.notify_whatsapp_e164 },
    { requestId },
  );
}
