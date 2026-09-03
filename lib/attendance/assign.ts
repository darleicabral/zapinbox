/**
 * Atribuição + aviso ao corretor no handoff bot→humano.
 *
 * Por que existe: essa lógica morava DENTRO da tool `crm_request_human_handoff`,
 * então só o handoff decidido pela IA atribuía e avisava. Os outros três
 * caminhos que chamam `triggerHandoff` (sentinela de texto do lead, worker de
 * sentimento e o ai-response-worker legado) silenciavam a conversa e não
 * avisavam ninguém: o lead digitava "quero falar com atendente", o bot calava, e
 * o corretor nunca sabia. Extraído pra cá e chamado pelo orquestrador, que é o
 * ponto central da transição, pra que TODO caminho atribua e avise.
 *
 * Nunca lança: qualquer falha vira `assignedUserId: null` e o handoff segue.
 * A conversa já está silenciada e o worker de SLA cuida do escalonamento.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { listAuthUsersByIds } from "@/lib/auth/admin-users";
import { logger } from "@/lib/logger";
import { notifyAssigneeNewLead } from "./notify";
import { loadAttendanceSettings, pickNextAssignee } from "./rotation";

export interface AssignAndNotifyResult {
  assignedUserId: string | null;
  /** Primeiro nome, pra IA citar ao cliente. Null quando ninguém foi atribuído. */
  assignedFirstName: string | null;
  /** true quando o rodízio (attendance_settings.enabled) está no comando. */
  rotationActive: boolean;
  /** true quando a conversa JÁ tinha dono e a gente só avisou, sem reatribuir. */
  keptExistingAssignee: boolean;
}

const VAZIO: AssignAndNotifyResult = {
  assignedUserId: null,
  assignedFirstName: null,
  rotationActive: false,
  keptExistingAssignee: false,
};

// O DONO (admin) não entra na distribuição normal — decisão do Darlei
// (03/09/2026): ele supervisiona, não atende. Mesma regra do rodízio em
// lib/attendance/rotation.ts. Quem pedir explicitamente minRole 'admin' ainda
// recebe admin, e a escalada do SLA (pickFallbackManager) também.
const ELIGIBLE_ROLES_BY_MIN: Record<string, string[]> = {
  agent: ["agent", "manager"],
  manager: ["manager"],
  admin: ["admin"],
};

/**
 * Fallback quando o rodízio C4 está desligado (attendance_settings.enabled=false):
 * atribuição simples, DETERMINÍSTICA (primeiro elegível por user_id), sem sorteio
 * e sem exigir presença — só pra a conversa não ficar órfã. O rodízio real
 * (circular por ponteiro, também sem exigir presença) vive em
 * lib/attendance/rotation.ts e é usado quando C4 liga.
 */
async function pickFirstEligible(
  client: SupabaseClient,
  organizationId: string,
  minRole: string,
): Promise<string | null> {
  const eligibleRoles = ELIGIBLE_ROLES_BY_MIN[minRole] ?? ["agent", "manager", "admin"];
  const { data, error } = await client
    .from("user_organizations")
    .select("user_id, role")
    .eq("organization_id", organizationId)
    .is("revoked_at", null)
    .in("role", eligibleRoles)
    .order("user_id", { ascending: true });

  if (error || !data || data.length === 0) return null;
  return (data[0] as { user_id: string }).user_id;
}

/** Primeiro nome do corretor pra IA citar. Qualquer falha vira null. */
async function resolveAssigneeFirstName(
  client: SupabaseClient,
  userId: string,
): Promise<string | null> {
  try {
    const [user] = await listAuthUsersByIds(client, [userId]);
    const meta = user?.raw_user_meta_data ?? null;
    const full =
      (typeof meta?.full_name === "string" && meta.full_name) ||
      (typeof meta?.name === "string" && meta.name) ||
      "";
    const first = full.trim().split(/\s+/)[0] ?? "";
    return first.length >= 2 ? first : null;
  } catch {
    return null;
  }
}

export async function assignAndNotify(
  client: SupabaseClient,
  args: {
    organizationId: string;
    conversationId: string;
    /** Papel mínimo pro fallback sem rodízio. Default 'agent'. */
    minRole?: string;
  },
): Promise<AssignAndNotifyResult> {
  try {
    const { data: conv } = await client
      .from("conversations")
      .select("id, assigned_to_user_id")
      .eq("id", args.conversationId)
      .eq("organization_id", args.organizationId)
      .maybeSingle();
    if (!conv) return VAZIO;

    const donoAtual = (conv as { assigned_to_user_id: string | null }).assigned_to_user_id ?? null;

    // Conversa já tem dono: NÃO reatribui (roubar atendimento em andamento é
    // pior que não avisar), só avisa quem já é responsável.
    if (donoAtual) {
      void notifyAssigneeNewLead(client, {
        organizationId: args.organizationId,
        conversationId: args.conversationId,
        assigneeUserId: donoAtual,
        kind: "assigned",
      });
      return {
        assignedUserId: donoAtual,
        assignedFirstName: await resolveAssigneeFirstName(client, donoAtual),
        rotationActive: false,
        keptExistingAssignee: true,
      };
    }

    // C4: rodízio real (online + ponteiro) quando o tenant habilitou; senão,
    // atribuição simples pra não deixar a conversa órfã.
    const settings = await loadAttendanceSettings(client, args.organizationId);
    const rotationActive = !!settings?.enabled;
    // pickNextAssignee distribui pra elegível ONLINE OU NÃO (decisão do Darlei,
    // 02/09/2026: corretor é mobile-first, recebe o aviso no zap e responde do
    // próprio número). Só volta null se a org não tiver nenhum corretor elegível;
    // aí a fila fica sem dono, o bot já está silenciado e o SLA reescala.
    const escolhido = rotationActive
      ? await pickNextAssignee(client, args.organizationId)
      : await pickFirstEligible(client, args.organizationId, args.minRole ?? "agent");

    if (!escolhido) return { ...VAZIO, rotationActive };

    const { error: assignErr } = await client
      .from("conversations")
      .update({
        assigned_to_user_id: escolhido,
        assigned_at: new Date().toISOString(),
        // Etapa 1 do SLA conta deste 1º repasse (só relevante com C4 on).
        ...(rotationActive ? { assignment_passes: 1 } : {}),
      })
      .eq("id", args.conversationId)
      .eq("organization_id", args.organizationId);

    if (assignErr) {
      logger.warn("[attendance.assign] falha ao atribuir", {
        error: assignErr.message,
        conversation_id: args.conversationId,
      });
      return { ...VAZIO, rotationActive };
    }

    // Avisa o corretor por WhatsApp + push (mobile-first). Fire-and-forget.
    void notifyAssigneeNewLead(client, {
      organizationId: args.organizationId,
      conversationId: args.conversationId,
      assigneeUserId: escolhido,
      kind: "assigned",
    });

    return {
      assignedUserId: escolhido,
      assignedFirstName: await resolveAssigneeFirstName(client, escolhido),
      rotationActive,
      keptExistingAssignee: false,
    };
  } catch (err) {
    logger.warn("[attendance.assign] erro inesperado", {
      error: err instanceof Error ? err.message : String(err),
      conversation_id: args.conversationId,
    });
    return VAZIO;
  }
}
