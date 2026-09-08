/**
 * GET  /api/v1/conversations/sem-corretor?dias=7   → a fila parada
 * POST /api/v1/conversations/sem-corretor          → distribui e avisa
 *
 * Pedido do Darlei (08/09/2026): "não posso deixar esses leads parados. Preciso
 * distribuí-los aos corretores e enviar a notificação a eles."
 *
 * O resgate automático (lib/attendance/parados.ts) só pega quem está ESPERANDO
 * resposta. Esta tela é pra outra pilha: o bot conversou, respondeu por último,
 * o lead não voltou, e nenhum corretor soube que ele existia — 46 casos de 7
 * dias na Avant quando isto foi escrito.
 *
 * Por que é MANUAL: distribuir dezenas de uma vez são dezenas de avisos no
 * WhatsApp dos corretores, e ligar tempo sobre acervo parado já rendeu 116
 * mensagens em 5 minutos (01/09/2026). Quem decide o lote é o gestor.
 *
 * GESTOR PRA CIMA, igual ao relatório: corretor não distribui lead pra colega.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { motivoDoLeadParaEncaminhar } from "@/lib/ai/runtime/handoff";
import { listarLeadsSemCorretor } from "@/lib/attendance/fila-parada";
import { notifyAssigneeNewLead } from "@/lib/attendance/notify";
import { pickNextAssignee } from "@/lib/attendance/rotation";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { validateRequest } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Papéis que atendem lead. Admin fora: "o dono não é corretor". */
const PAPEIS_QUE_ATENDEM = ["agent", "manager"];

/**
 * Teto por chamada. Cada item acorda um corretor no WhatsApp; lote gigante num
 * clique é o caminho mais curto pro incidente de 01/09 de novo.
 */
const TETO_POR_LOTE = 25;

const distribuirSchema = z.object({
  conversation_ids: z.array(z.string().uuid()).min(1).max(TETO_POR_LOTE),
  /** Corretor escolhido; ausente = rodízio decide um por conversa. */
  user_id: z.string().uuid().optional(),
});

async function contexto(requestId: string) {
  const supabase = await createClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return { erro: fail("unauthenticated", "Auth required.", 401, { requestId }) };
  }
  const authUser = await loadAuthUser();
  const activeOrg = authUser ? await resolveActiveOrg(authUser) : null;
  if (!activeOrg) {
    return { erro: fail("no_active_org", "Nenhuma organização ativa.", 403, { requestId }) };
  }
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK["manager"]) {
    return {
      erro: fail("forbidden", "Só gestor distribui lead da equipe.", 403, { requestId }),
    };
  }
  return { supabase, orgId: activeOrg.orgId, userId: user.id };
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const ctx = await contexto(requestId);
  if (ctx.erro) return ctx.erro;

  const diasBruto = Number(new URL(req.url).searchParams.get("dias") ?? "7");
  const dias = [1, 7, 30].includes(diasBruto) ? diasBruto : 7;

  try {
    const fila = await listarLeadsSemCorretor(ctx.supabase!, ctx.orgId!, { dias });
    return ok({ dias, total: fila.length, leads: fila }, { requestId });
  } catch (err) {
    return fail("query_failed", err instanceof Error ? err.message : String(err), 500, {
      requestId,
    });
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const ctx = await contexto(requestId);
  if (ctx.erro) return ctx.erro;
  const supabase = ctx.supabase!;
  const orgId = ctx.orgId!;

  let input;
  try {
    input = await validateRequest(distribuirSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  // Alvo fixo, quando informado: tem de ser membro ativo que atende lead.
  if (input.user_id) {
    const { data: membro } = await supabase
      .from("user_organizations")
      .select("user_id, role")
      .eq("organization_id", orgId)
      .eq("user_id", input.user_id)
      .is("revoked_at", null)
      .maybeSingle();
    const papel = (membro as { role: string } | null)?.role;
    if (!papel || !PAPEIS_QUE_ATENDEM.includes(papel)) {
      return fail("invalid_request", "Só dá pra atribuir a corretor ou gerente.", 422, {
        requestId,
      });
    }
  }

  // O aviso e a atribuição usam o client ADMIN: notifyAssigneeNewLead lê
  // contato, lead e imóvel e manda pelo WAHA, fora do alcance da RLS do caller.
  const admin = createAdminClient();
  const feitos: { conversation_id: string; assigned_to: string; notified: boolean }[] = [];
  const pulados: { conversation_id: string; motivo: string }[] = [];

  for (const convId of input.conversation_ids) {
    const alvo = input.user_id ?? (await pickNextAssignee(admin, orgId, {}));
    if (!alvo) {
      pulados.push({ conversation_id: convId, motivo: "nenhum corretor elegível" });
      continue;
    }

    // CAS em assigned_to_user_id: se o bot encaminhou essa conversa enquanto a
    // tela estava aberta, quem chegou primeiro fica com ela. Sem isto o clique
    // do gestor roubaria um lead que já tem dono, que é justamente o que o
    // "lead nunca passa adiante" proíbe.
    const agora = new Date().toISOString();
    const { data: aplicado } = await admin
      .from("conversations")
      .update({
        assigned_to_user_id: alvo,
        assigned_at: agora,
        status: "claimed",
        status_changed_at: agora,
        assignment_passes: 1,
      })
      .eq("id", convId)
      .eq("organization_id", orgId)
      .is("assigned_to_user_id", null)
      .select("id")
      .maybeSingle();
    if (!aplicado) {
      pulados.push({ conversation_id: convId, motivo: "já tinha dono" });
      continue;
    }

    // Recado do lead no aviso: as três últimas entradas, porque o "só depois
    // das 19h" costuma vir antes da última mensagem.
    const { data: ultimas } = await admin
      .from("messages")
      .select("body")
      .eq("organization_id", orgId)
      .eq("conversation_id", convId)
      .eq("direction", "inbound")
      .order("created_at", { ascending: false })
      .limit(3);
    const recado =
      ((ultimas ?? []) as { body: string | null }[])
        .map((m) => motivoDoLeadParaEncaminhar(m.body ?? ""))
        .find((r) => r !== null) ?? null;

    // AWAIT, nunca `void`: aviso solto em serverless morre com a função.
    const avisou = await notifyAssigneeNewLead(admin, {
      organizationId: orgId,
      conversationId: convId,
      assigneeUserId: alvo,
      kind: "assigned",
      observacao: recado,
    });
    feitos.push({ conversation_id: convId, assigned_to: alvo, notified: avisou });
  }

  await audit({
    action: "conversation.assigned",
    organizationId: orgId,
    resourceType: "conversation",
    requestId,
    actorUserId: ctx.userId,
    metadata: {
      pedidos: input.conversation_ids.length,
      distribuidos: feitos.length,
      pulados: pulados.length,
      alvo_fixo: input.user_id ?? null,
    },
  });

  return ok({ distribuidos: feitos, pulados }, { requestId });
}
