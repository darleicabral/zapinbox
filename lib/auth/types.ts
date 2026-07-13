export type Role = "viewer" | "agent" | "manager" | "admin";
export const ROLE_RANK: Record<Role, number> = { viewer: 1, agent: 2, manager: 3, admin: 4 };

export interface UserOrgMembership {
  organization_id: string;
  organization_name: string;
  role: Role;
}

export interface AuthUser {
  id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  is_platform_admin: boolean;
  organizations: UserOrgMembership[];
}

export interface ActiveOrg {
  orgId: string;
  name: string;
  role: Role;
  /** true quando o escopo veio do cookie de impersonate (platform admin agindo como o tenant). */
  impersonated?: boolean;
}
