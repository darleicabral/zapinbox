import { type NextRequest } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { listAuthUsersByIds } from "@/lib/auth/admin-users";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// T-04 (Spec 01 §3.4): platform_admins is managed exclusively by DBA via SQL.
// This route is strictly READ-ONLY. POST/PATCH/DELETE return 405 explicitly.
// ---------------------------------------------------------------------------

const T04_MESSAGE = "platform_admins é gerenciado exclusivamente via DBA (Spec 01 §3.4 T-04)";

// ---------------------------------------------------------------------------
// GET /api/v1/admin/platform-admins
// ---------------------------------------------------------------------------

export async function GET(_req: NextRequest) {
  const requestId = randomUUID();

  let adminCtx: Awaited<ReturnType<typeof requirePlatformAdmin>>;
  try {
    adminCtx = await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required", 403, { requestId });
  }

  const admin = createAdminClient();

  // Step 1: fetch all platform_admins rows
  const { data: paRows, error: paError } = await admin
    .from("platform_admins")
    .select(
      "id, user_id, granted_by, granted_at, scope, mfa_required, reason, revoked_at, revoked_by, revoke_reason",
    )
    .order("granted_at", { ascending: false });

  if (paError) {
    return fail("internal_error", "Query failed", 500, {
      requestId,
      details: paError.message,
    });
  }

  if (!paRows || paRows.length === 0) {
    void audit({
      action: "platform_admin.platform_admins_listed",
      actorUserId: adminCtx.user.id,
      actingAsPlatformAdmin: true,
      bypassedRls: true,
      requestId,
      metadata: { result_count: 0 },
    });
    return ok([], { requestId });
  }

  // Step 2: collect all user IDs that need resolution (user, granted_by, revoked_by)
  const userIdSet = new Set<string>();
  for (const row of paRows) {
    userIdSet.add(row.user_id);
    if (row.granted_by) userIdSet.add(row.granted_by);
    if (row.revoked_by) userIdSet.add(row.revoked_by);
  }
  const allUserIds = Array.from(userIdSet);

  // Step 3: e-mails via Admin API do Auth. NÃO dá para consultar auth.users
  // pelo PostgREST (PGRST106: schema não exposto) — ver lib/auth/admin-users.ts.
  const authUsersData = await listAuthUsersByIds(admin, allUserIds);

  type AuthUser = {
    id: string;
    email: string | null;
    raw_user_meta_data: Record<string, unknown> | null;
  };

  const authMap = new Map<string, AuthUser>(
    ((authUsersData as AuthUser[]) ?? []).map((u) => [u.id, u]),
  );

  // Step 4: build enriched rows
  const data = paRows.map((pa) => {
    const targetUser = authMap.get(pa.user_id);
    const grantedByUser = pa.granted_by ? authMap.get(pa.granted_by) : null;
    const revokedByUser = pa.revoked_by ? authMap.get(pa.revoked_by) : null;

    return {
      id: pa.id,
      user_id: pa.user_id,
      user_email: targetUser?.email ?? null,
      user_name: (targetUser?.raw_user_meta_data?.full_name as string | undefined) ?? null,
      granted_by: pa.granted_by,
      granted_by_email: grantedByUser?.email ?? null,
      granted_at: pa.granted_at,
      scope: pa.scope,
      mfa_required: pa.mfa_required,
      reason: pa.reason,
      revoked_at: pa.revoked_at,
      revoked_by: pa.revoked_by,
      revoked_by_email: revokedByUser?.email ?? null,
      revoke_reason: pa.revoke_reason,
    };
  });

  void audit({
    action: "platform_admin.platform_admins_listed",
    actorUserId: adminCtx.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    requestId,
    metadata: { result_count: data.length },
  });

  return ok(data, { requestId });
}

// ---------------------------------------------------------------------------
// T-04 enforcement: POST / PATCH / DELETE return 405 explicitly
// ---------------------------------------------------------------------------

function methodNotAllowed() {
  return new Response(
    JSON.stringify({
      error: {
        code: "method_not_allowed",
        message: T04_MESSAGE,
      },
    }),
    {
      status: 405,
      headers: {
        "Content-Type": "application/json",
        Allow: "GET",
      },
    },
  );
}

export function POST() {
  return methodNotAllowed();
}

export function PATCH() {
  return methodNotAllowed();
}

export function DELETE() {
  return methodNotAllowed();
}

export type PlatformAdminRow = Awaited<ReturnType<typeof GET>> extends Response ? never : never;
