/**
 * Achar um usuário do Auth pelo e-mail, com service role.
 *
 * ⚠️ NÃO consulte `auth.users` via PostgREST (`admin.schema("auth")...`): o
 * schema `auth` não é exposto na API do Supabase e a resposta é
 * `PGRST106 Invalid schema: auth`. Foi o que derrubou o cadastro de usuário com
 * "Erro interno" em 26/07 (o convite por e-mail tinha o mesmo defeito, só que
 * dentro de um try/catch — a pré-checagem de "já é membro" nunca funcionou).
 *
 * O SDK não tem busca por e-mail, então paginamos o endpoint admin. Para bases
 * de dezenas/centenas de usuários resolve na primeira página.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

const PER_PAGE = 200;
/** Teto de páginas: 5.000 usuários. Acima disso, buscar por e-mail assim não serve. */
const MAX_PAGES = 25;

/** Campos do usuário do Auth que as telas usam (nomes iguais aos de auth.users). */
export interface AuthUserLite {
  id: string;
  email: string | null;
  last_sign_in_at: string | null;
  created_at: string;
  raw_user_meta_data: Record<string, unknown> | null;
}

/**
 * Resolve vários usuários por ID (o console de plataforma monta a lista de
 * membros a partir de `user_organizations` e precisa dos e-mails). Mesmo motivo
 * do helper acima: `.in("id", ids)` em `auth.users` não passa pelo PostgREST.
 */
export async function listAuthUsersByIds(
  admin: SupabaseClient,
  ids: string[],
): Promise<AuthUserLite[]> {
  const wanted = new Set(ids);
  if (wanted.size === 0) return [];
  const out: AuthUserLite[] = [];

  for (let page = 1; page <= MAX_PAGES && out.length < wanted.size; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: PER_PAGE });
    if (error || !data) break;
    for (const u of data.users) {
      if (!wanted.has(u.id)) continue;
      out.push({
        id: u.id,
        email: u.email ?? null,
        last_sign_in_at: u.last_sign_in_at ?? null,
        created_at: u.created_at,
        raw_user_meta_data: (u.user_metadata ?? null) as Record<string, unknown> | null,
      });
    }
    if (data.users.length < PER_PAGE) break; // última página
  }
  return out;
}

export async function findAuthUserIdByEmail(
  admin: SupabaseClient,
  email: string,
): Promise<string | null> {
  const target = email.trim().toLowerCase();
  if (!target) return null;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: PER_PAGE });
    if (error || !data) return null;
    const hit = data.users.find((u) => (u.email ?? "").toLowerCase() === target);
    if (hit) return hit.id;
    if (data.users.length < PER_PAGE) return null; // última página
  }
  return null;
}
