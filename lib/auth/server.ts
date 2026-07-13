/**
 * Server-side auth helpers — load AuthUser, resolve active org, gate routes.
 *
 * Uses the service-role admin client to read tenant-scoped tables
 * (`user_organizations`, `platform_admins`, `organizations`) — RLS bypass is
 * intentional here because we resolve the user from the validated JWT first
 * and then filter by `user_id` (a trusted source).
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  IMPERSONATE_COOKIE_NAME,
  verifyImpersonateCookie,
} from "@/lib/impersonate/cookie";
import type { AuthUser, Role, UserOrgMembership, ActiveOrg } from "./types";

const ACTIVE_ORG_COOKIE = "active_org";

interface RawMembershipRow {
  organization_id: string;
  role: string;
  organizations: { display_name: string } | { display_name: string }[] | null;
}

/**
 * Loads the AuthUser for the current request. Returns null if unauthenticated.
 * Use only in Server Components / Route Handlers / Server Actions.
 *
 * Uses the user-scoped server client (cookie session). RLS policies allow:
 * - user_organizations: user_id = auth.uid() (user_orgs_select)
 * - organizations: id IN fn_user_org_ids()  (orgs_select)
 * - platform_admins: only platform admins read (so non-admins get null — correct)
 */
export async function loadAuthUser(): Promise<AuthUser | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  // Platform admin? (active = no revoked_at). RLS returns null for non-admins.
  const { data: paRow } = await supabase
    .from("platform_admins")
    .select("user_id, revoked_at")
    .eq("user_id", user.id)
    .is("revoked_at", null)
    .maybeSingle();

  // Org memberships (only active = not revoked, accepted)
  const { data: rawMemberships } = await supabase
    .from("user_organizations")
    .select("organization_id, role, organizations(display_name)")
    .eq("user_id", user.id)
    .is("revoked_at", null);

  const rows = (rawMemberships ?? []) as RawMembershipRow[];
  const memberships: UserOrgMembership[] = rows.map((row) => {
    const orgs = row.organizations;
    const name = Array.isArray(orgs) ? (orgs[0]?.display_name ?? "—") : (orgs?.display_name ?? "—");
    return {
      organization_id: row.organization_id,
      organization_name: name,
      role: row.role as Role,
    };
  });

  const fullName = (user.user_metadata?.full_name as string | undefined) ?? null;
  const avatarUrl = (user.user_metadata?.avatar_url as string | undefined) ?? null;

  return {
    id: user.id,
    email: user.email ?? "",
    full_name: fullName,
    avatar_url: avatarUrl,
    is_platform_admin: !!paRow,
    organizations: memberships,
  };
}

/**
 * Resolves the active organization for the current request.
 * Priority: impersonate cookie (platform admin agindo como tenant) →
 * cookie `active_org` (if member of) → first membership.
 * Returns null if user has zero memberships (and no valid impersonation).
 */
export async function resolveActiveOrg(authUser: AuthUser): Promise<ActiveOrg | null> {
  const store = await cookies();

  // Impersonate: escopa TODO o app pro tenant do cookie, não só o banner.
  // Só vale pra platform admin e só se o cookie foi emitido pra ELE (HMAC +
  // TTL verificados). O RLS já permite o acesso via fn_is_platform_admin().
  if (authUser.is_platform_admin) {
    const impToken = store.get(IMPERSONATE_COOKIE_NAME)?.value;
    if (impToken) {
      const verified = verifyImpersonateCookie(impToken);
      if (verified.valid && verified.payload?.platformAdminId === authUser.id) {
        const supabase = await createClient();
        const { data: org } = await supabase
          .from("organizations")
          .select("id, display_name")
          .eq("id", verified.payload.tenantId)
          .maybeSingle();
        if (org) {
          return {
            orgId: org.id as string,
            name: (org.display_name as string) ?? "Tenant",
            role: "admin",
            impersonated: true,
          };
        }
      }
    }
  }

  if (authUser.organizations.length === 0) return null;
  const cookieOrg = store.get(ACTIVE_ORG_COOKIE)?.value;
  if (cookieOrg) {
    const found = authUser.organizations.find((o) => o.organization_id === cookieOrg);
    if (found) {
      return { orgId: found.organization_id, name: found.organization_name, role: found.role };
    }
  }
  const first = authUser.organizations[0];
  if (!first) return null;
  return { orgId: first.organization_id, name: first.organization_name, role: first.role };
}

/**
 * For Server Components / Server Actions in /app/(app)/* routes — guarantees
 * an authenticated user. Redirects to /login if not.
 */
export async function requireAuth(): Promise<AuthUser> {
  const user = await loadAuthUser();
  if (!user) redirect("/login");
  return user;
}

/**
 * Returns true if the current session has at least one verified TOTP factor.
 * Use only in Server Components / Server Actions (cookie session).
 */
export async function isMfaEnrolled(): Promise<boolean> {
  const supabase = await createClient();
  const { data } = await supabase.auth.mfa.listFactors();
  return !!data?.totp?.some((f) => f.status === "verified");
}

/**
 * MFA enforcement policy: platform admins and tenant `admin` role MUST enroll.
 * `manager`/`agent`/`viewer` are optional in MVP.
 */
export function requiresMfa(role: Role | undefined, isPlatformAdmin: boolean): boolean {
  return isPlatformAdmin || role === "admin";
}
