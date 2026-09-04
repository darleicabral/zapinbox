/**
 * GET /api/v1/reports/distribuicao?dias=0|7|30
 *
 * Quantos leads cada corretor recebeu (via notificação). Pedido do Darlei
 * (04/09/2026), pra acompanhar em tempo real.
 *
 * NÃO mede resposta do corretor: ele atende do WhatsApp PESSOAL e isso não passa
 * pelo CRM — ver o cabeçalho de lib/reports/distribuicao.ts.
 *
 * GESTOR PRA CIMA. Corretor não vê o número dos colegas — ele já só enxerga os
 * leads dele no inbox (mesma decisão do dia), e um painel comparativo seria a
 * porta dos fundos disso.
 *
 * Tenant-scoped pelo client de SESSÃO (a RLS isola a org) + organization_id
 * explícito por garantia. Agregação em JS (lib/reports/distribuicao.ts).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { listAuthUsersByIds } from "@/lib/auth/admin-users";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  computeDistribuicao,
  type ConversaAtribuida,
  type Corretor,
} from "@/lib/reports/distribuicao";

export const dynamic = "force-dynamic";

/** Papéis que atendem lead — os mesmos da atribuição manual. */
const PAPEIS_QUE_ATENDEM = ["agent", "manager"];

/**
 * 00:00 de hoje em Brasília, como instante UTC.
 *
 * Fuso importa: sem isto o "hoje" do relatório mudaria com o fuso de quem abre
 * a tela, e o gestor veria número diferente do corretor. São Paulo é UTC-3 fixo
 * desde 2019 (sem horário de verão), então 00:00 lá é 03:00Z do mesmo dia.
 */
function inicioDoDiaEmBrasilia(): string {
  const emBrasilia = new Date(Date.now() - 3 * 3_600_000);
  return new Date(
    Date.UTC(emBrasilia.getUTCFullYear(), emBrasilia.getUTCMonth(), emBrasilia.getUTCDate(), 3),
  ).toISOString();
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const supabase = await createClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) return fail("unauthenticated", "Auth required.", 401, { requestId });

  const authUser = await loadAuthUser();
  const activeOrg = authUser ? await resolveActiveOrg(authUser) : null;
  if (!activeOrg) return fail("no_active_org", "Nenhuma organização ativa.", 403, { requestId });
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK["manager"]) {
    return fail("forbidden", "Só gestor vê a distribuição da equipe.", 403, { requestId });
  }

  // Janela: 0 = hoje (desde 00:00 no fuso da operação), senão N dias pra trás.
  const diasBruto = Number(new URL(req.url).searchParams.get("dias") ?? "0");
  const dias = [0, 7, 30].includes(diasBruto) ? diasBruto : 0;
  const desde = dias === 0 ? inicioDoDiaEmBrasilia() : new Date(Date.now() - dias * 24 * 3_600_000).toISOString();

  const { data: convRows, error: convErr } = await supabase
    .from("conversations")
    .select("id, assigned_to_user_id, assigned_at")
    .eq("organization_id", activeOrg.orgId)
    .not("assigned_to_user_id", "is", null)
    .gte("assigned_at", desde)
    .limit(5000);
  if (convErr) return fail("query_failed", convErr.message, 500, { requestId });
  const conversas = (convRows ?? []) as unknown as ConversaAtribuida[];

  // Equipe: quem atende, ativo. Entra mesmo com zero lead — corretor de fora da
  // lista pareceria "sem lead nenhum" quando o caso é não estar no rodízio.
  const { data: membros, error: memErr } = await supabase
    .from("user_organizations")
    .select("user_id, role, notify_whatsapp_e164")
    .eq("organization_id", activeOrg.orgId)
    .is("revoked_at", null);
  if (memErr) return fail("query_failed", memErr.message, 500, { requestId });
  const atendem = ((membros ?? []) as { user_id: string; role: string; notify_whatsapp_e164: string | null }[])
    .filter((m) => PAPEIS_QUE_ATENDEM.includes(m.role));

  let nomes = new Map<string, string>();
  try {
    // Client ADMIN só aqui: `auth.admin` exige service role, e o escopo por org
    // já foi garantido pela consulta de membros acima.
    const users = await listAuthUsersByIds(createAdminClient(), atendem.map((m) => m.user_id));
    nomes = new Map(
      users.map((u) => {
        const meta = (u.raw_user_meta_data ?? {}) as { full_name?: unknown; name?: unknown };
        const full =
          (typeof meta.full_name === "string" && meta.full_name) ||
          (typeof meta.name === "string" && meta.name) ||
          u.email ||
          "";
        return [u.id, String(full).trim()];
      }),
    );
  } catch {
    /* sem nome o painel ainda serve: cai no id curto abaixo */
  }

  const corretores: Corretor[] = atendem.map((m) => ({
    userId: m.user_id,
    nome: nomes.get(m.user_id) || m.user_id.slice(0, 8),
    semTelefone: !m.notify_whatsapp_e164,
  }));

  return ok(computeDistribuicao(conversas, corretores, desde), { requestId });
}
