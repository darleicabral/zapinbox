/**
 * POST /api/v1/team/users — cadastra um membro DIRETO, com senha inicial.
 *
 * Complementa o convite por e-mail (`/api/v1/team/invite`): aqui a conta já
 * nasce ativa e confirmada, e o admin entrega a senha pessoalmente. É o caminho
 * da operação real (a atendente está do lado; esperar e-mail só atrasa) e o
 * mesmo que o seed fazia por script.
 *
 * Gerente pra cima na org ativa, e gerente só cadastra até gerente (não cria
 * admin). Precisa de service role (cria usuário no Auth).
 * Se o e-mail JÁ tem conta, não mexe na senha: só vincula (ou reativa) a
 * associação com a org — trocar a senha de alguém por engano é irreversível
 * para quem já usava a conta noutro tenant.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { audit, isServiceRoleConfigured } from "@/lib/audit";
import { findAuthUserIdByEmail } from "@/lib/auth/admin-users";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { canAssignRole, canManageTeam } from "@/lib/auth/permissions";
import { createMemberSchema, validateRequest } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const authUser = await loadAuthUser();
  if (!authUser) return fail("unauthenticated", "Auth required.", 401, { requestId });
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) return fail("forbidden_tenant", "Sem organização ativa.", 403, { requestId });
  if (!authUser.is_platform_admin && !canManageTeam(activeOrg.role)) {
    return fail("forbidden_role", "Apenas gerentes e admins podem cadastrar usuários.", 403, {
      requestId,
    });
  }
  if (!isServiceRoleConfigured()) {
    return fail(
      "service_role_missing",
      "Cadastro direto exige a chave de serviço do Supabase configurada.",
      503,
      { requestId },
    );
  }

  let input;
  try {
    input = await validateRequest(createMemberSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  // Gerente cadastra até gerente; admin, qualquer nível.
  if (!canAssignRole(activeOrg.role, input.role)) {
    return fail("forbidden_role", "Gerente não pode cadastrar administrador.", 403, { requestId });
  }

  const email = input.email.trim().toLowerCase();
  const admin = createAdminClient();

  // Conta já existe? (o mesmo e-mail pode ser membro de outro tenant)
  let userId = await findAuthUserIdByEmail(admin, email);
  let reusedAccount = !!userId;

  if (!userId) {
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password: input.password,
      email_confirm: true,
      user_metadata: input.full_name ? { full_name: input.full_name } : {},
    });
    if (createErr || !created?.user) {
      // O GoTrue recusa e-mail repetido: pode ser corrida ou base grande demais
      // para a paginação acima. Procura de novo antes de desistir.
      const raced = await findAuthUserIdByEmail(admin, email);
      if (!raced) {
        return fail("create_user_failed", createErr?.message ?? "Falha ao criar o usuário.", 422, {
          requestId,
        });
      }
      userId = raced;
      reusedAccount = true;
    } else {
      userId = created.user.id;
    }
  }

  // Associação com a org: cria, ou reativa a que foi revogada.
  const nowIso = new Date().toISOString();
  const { data: membership, error: memberErr } = await admin
    .from("user_organizations")
    .select("id, revoked_at")
    .eq("user_id", userId)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (memberErr) {
    return fail("internal_error", memberErr.message, 500, { requestId });
  }

  const existingMembership = membership as { id: string; revoked_at: string | null } | null;
  if (existingMembership && !existingMembership.revoked_at) {
    return fail("already_member", "Esse e-mail já é membro ativo desta organização.", 409, {
      requestId,
    });
  }

  if (existingMembership) {
    const { error: reactErr } = await admin
      .from("user_organizations")
      .update({ role: input.role, revoked_at: null, accepted_at: nowIso })
      .eq("id", existingMembership.id);
    if (reactErr) return fail("internal_error", reactErr.message, 500, { requestId });
  } else {
    const { error: insErr } = await admin.from("user_organizations").insert({
      user_id: userId,
      organization_id: activeOrg.orgId,
      role: input.role,
      accepted_at: nowIso,
      invited_by: authUser.id,
    });
    if (insErr) return fail("internal_error", insErr.message, 500, { requestId });
  }

  await audit({
    action: "member.accepted",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "user_organization",
    resourceId: userId,
    requestId,
    metadata: {
      created_directly: true,
      reused_existing_account: reusedAccount,
      reactivated: !!existingMembership,
      role: input.role,
      email,
    },
  });

  return ok(
    {
      user_id: userId,
      email,
      role: input.role,
      /** false quando o e-mail já tinha conta: a senha informada foi ignorada. */
      password_applied: !reusedAccount,
      reactivated: !!existingMembership,
    },
    { requestId },
  );
}
