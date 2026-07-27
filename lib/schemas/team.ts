/**
 * EPIC-09 Team & Permissions — Zod schemas for invite, accept, role change, and api token.
 *
 * Roles are stored as `text` with a check constraint (not enum) on
 * `user_organizations.role` per project doctrine — keep this list in sync
 * with the DB constraint when adding/removing roles.
 */
import { z } from "zod";

export const ROLES = ["viewer", "agent", "manager", "admin"] as const;
export type Role = (typeof ROLES)[number];

export const inviteMemberSchema = z.object({
  invitations: z
    .array(
      z.object({
        email: z.string().email(),
        role: z.enum(ROLES),
      }),
    )
    .min(1)
    .max(20),
});
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;

/**
 * Cadastro DIRETO de membro (sem convite por e-mail): o admin define a senha
 * inicial e a pessoa já entra ativa. Existe porque a operação real cria conta
 * para gente que está do lado, e depender de e-mail chegar só atrasa.
 */
export const createMemberSchema = z.object({
  email: z.string().email(),
  full_name: z.string().trim().min(2).max(120).optional(),
  // 10+ porque quem escolhe é o admin, não a pessoa: senha curta aqui vira
  // senha curta pra sempre. Teto 72 = limite do bcrypt do Supabase Auth.
  password: z.string().min(10).max(72),
  role: z.enum(ROLES),
});
export type CreateMemberInput = z.infer<typeof createMemberSchema>;

export const acceptInviteSchema = z.object({
  token: z.string().min(20),
});
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;

export const changeRoleSchema = z.object({
  role: z.enum(ROLES),
});
export type ChangeRoleInput = z.infer<typeof changeRoleSchema>;

export const createApiTokenSchema = z.object({
  name: z.string().min(2).max(100),
  scopes: z.array(z.string()).min(1),
  expires_in_days: z.coerce.number().int().min(1).max(365).optional(),
});
export type CreateApiTokenInput = z.infer<typeof createApiTokenSchema>;
