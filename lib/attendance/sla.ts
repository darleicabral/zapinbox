/**
 * C4 — Distribuição de lead, consumida pelo cron `/api/v1/cron/attendance-sla`.
 *
 * Faz UMA coisa: conversa `pending` SEM dono → atribui ao próximo do rodízio e
 * avisa ele. Conversa que JÁ TEM dono não é tocada, nunca.
 *
 * SÓ ISSO. Nao ha etapa 2.
 *
 * ⚠️ Reescrito em 04/09/2026, por tres decisoes do Darlei no mesmo dia:
 *
 *  1. "O lead nunca deve passar adiante" + "a IA vai dizer para o lead quem vai
 *     atender ele e isso nao deve mudar". O bot cita o NOME do corretor pro
 *     cliente, entao trocar de dono depois faz o bot mentir. O repasse por claim
 *     e a escalada que trocava o dono foram REMOVIDOS. Antes disso a "Cris"
 *     trocou de dono 6 vezes em 28 minutos, cada passe com um aviso.
 *
 *  2. Responder ao lead do PROPRIO CELULAR conta como assumir (`external_device`):
 *     o corretor nunca abre o CRM pra clicar "Assumir".
 *
 *  3. "Nao precisa alertar". A cobranca de 1a resposta foi REMOVIDA inteira. Ela
 *     media "ninguem respondeu no sistema", que e a coisa errada quando o
 *     atendimento acontece no celular do corretor — e o Cleber levou 12 alertas
 *     num dia, metade deles sem ninguem esperando nada. `max_passes`,
 *     `assignment_passes`, `first_response_sla_minutes` e
 *     `first_response_alerted_at` ficaram sem uso.
 *
 * Alertas: emit_event no event_log + broadcast realtime em `org:<org>:queue`
 * (mesmo canal que o handoff usa pra acender a UI da fila). Sem tabela de
 * notificações no schema — a UI consome o realtime/event_log.
 *
 * Service-role: filtra `organization_id` em toda query (RLS bypass).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  carregarTelefonesDaEquipe,
  ehTelefoneDaEquipe,
  marcarContatoInterno,
} from "./interno";
import { notifyAssigneeNewLead } from "./notify";
import {
  inBusinessHours,
  loadAttendanceSettings,
  pickNextAssignee,
  type AttendanceSettings,
} from "./rotation";

export interface SlaSweepSummary {
  orgs_scanned: number;
  reassigned: number;
  escalated_to_manager: number;
  first_response_alerts: number;
  left_unassigned: number;
  errors: string[];
}

interface ContatoDaConversa {
  id: string;
  is_internal: boolean | null;
  phone_number: string | null;
}

/** PostgREST tipa relação embutida como array; na prática vem um só. */
type ContatoEmbutido = ContatoDaConversa | ContatoDaConversa[] | null;

function primeiroContato(c: ContatoEmbutido): ContatoDaConversa | null {
  return Array.isArray(c) ? (c[0] ?? null) : c;
}

interface PendingConv {
  id: string;
  assigned_to_user_id: string | null;
  assigned_at: string | null;
  status_changed_at: string;
  assignment_passes: number;
  contacts: ContatoEmbutido;
}

function emptySummary(): SlaSweepSummary {
  return {
    orgs_scanned: 0,
    reassigned: 0,
    escalated_to_manager: 0,
    first_response_alerts: 0,
    left_unassigned: 0,
    errors: [],
  };
}

async function emitAlert(
  admin: SupabaseClient,
  organizationId: string,
  eventType: string,
  conversationId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await admin.rpc("emit_event" as never, {
      p_event_type: eventType,
      p_entity_kind: "conversation",
      p_entity_id: conversationId,
      p_payload: { conversation_id: conversationId, ...payload },
      p_metadata: { source: "attendance-sla" },
      p_organization_id: organizationId,
    } as never);
  } catch {
    /* event_log best-effort */
  }
  try {
    const channel = admin.channel(`org:${organizationId}:queue`);
    await channel.send({
      type: "broadcast",
      event: eventType,
      payload: { conversation_id: conversationId, ...payload },
    });
    await admin.removeChannel(channel);
  } catch {
    /* realtime best-effort */
  }
}

async function sweepOrg(
  admin: SupabaseClient,
  settings: AttendanceSettings,
  now: number,
  summary: SlaSweepSummary,
): Promise<void> {
  const orgId = settings.organization_id;
  const claimCutoff = now - settings.claim_sla_minutes * 60_000;

  // ── Distribuição: só conversa sem dono ─────────────────────────────────
  const { data: pendingRows } = await admin
    .from("conversations")
    .select(
      "id, assigned_to_user_id, assigned_at, status_changed_at, assignment_passes, contacts:contact_id (id, is_internal, phone_number)",
    )
    .eq("organization_id", orgId)
    .eq("status", "pending");

  // Telefones de aviso da equipe: uma query por passada. Serve pra reconhecer
  // a conversa que e do PROPRIO corretor (nasceu do eco da notificacao) e que
  // por isso nao pode entrar no rodizio.
  const telefonesDaEquipe = await carregarTelefonesDaEquipe(admin, orgId);

  for (const conv of (pendingRows ?? []) as unknown as PendingConv[]) {
    // A conversa do PROPRIO corretor nao e lead (decisao do Darlei, 03/09/2026:
    // "marcar como interna"). Sem esta guarda o aviso que o CRM manda pro
    // WhatsApp dele volta como eco, cria conversa `pending`, e o rodizio a
    // repassa pra outro corretor: laco.
    const contato = primeiroContato(conv.contacts);
    if (contato?.is_internal) continue;
    if (contato && ehTelefoneDaEquipe(contato.phone_number, telefonesDaEquipe)) {
      // Auto-cura: marca na primeira vez que o laço tentaria começar.
      await marcarContatoInterno(admin, orgId, contato.id);
      continue;
    }
    // Relógio da etapa 1: quando foi atribuída (ou, sem dono, quando virou pending).
    const clock = new Date(conv.assigned_at ?? conv.status_changed_at).getTime();
    if (clock > claimCutoff) continue; // ainda dentro do SLA

    // 🐛 04/09/2026 — a "Cris" foi repassada SEIS vezes em 28 minutos, cada
    // passe avisando um corretor diferente, e o Darlei viu o aviso no zap do
    // Gilvam enquanto o sistema já tinha movido o lead pro Cleber.
    //
    // Premissa errada minha: o relógio de claim esperava alguém clicar
    // "Assumir" no CRM. Mas o desenho é o oposto — o corretor recebe o aviso e
    // responde do PRÓPRIO WhatsApp, sem abrir o CRM (decisão do Darlei em
    // 03/09: "o corretor recebe a notificação mesmo estando off"). Ninguém
    // clicava, o claim nunca era satisfeito, e a conversa girava pra sempre.
    //
    // Responder ao lead É assumir. `external_device` é exatamente a mensagem
    // que saiu do celular dele (o que o CRM manda entra como 'ai' ou 'user').
    if (conv.assigned_to_user_id && conv.assigned_at) {
      const { count: respostasDoCorretor } = await admin
        .from("messages")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId)
        .eq("conversation_id", conv.id)
        .eq("direction", "outbound")
        .eq("sent_via", "external_device")
        .gt("created_at", conv.assigned_at);
      if ((respostasDoCorretor ?? 0) > 0) {
        // Sai do bolo de `pending`: quem está atendendo não volta pro rodízio.
        await admin
          .from("conversations")
          .update({ status: "claimed", status_changed_at: new Date(now).toISOString() })
          .eq("id", conv.id)
          .eq("organization_id", orgId);
        continue;
      }
    }

    // 🚫 O LEAD NUNCA PASSA ADIANTE (decisão do Darlei, 04/09/2026): "o lead
    // nunca deve passar adiante" + "a IA vai dizer para o lead quem vai atender
    // ele e isso não deve mudar".
    //
    // O bot fala o NOME do corretor pro cliente ("vou te encaminhar pro
    // Gilvam"). Repassar depois faz duas coisas ruins de uma vez: o bot mente
    // pro cliente, e o corretor fica com um aviso de lead que já não é dele. Em
    // 04/09 a "Cris" trocou de dono 6 vezes em 28 minutos.
    //
    // Então o rodízio só age em conversa SEM dono. Quem já tem dono não muda —
    // se ele não responder, a etapa 2 avisa o gestor SEM tirar o lead dele.
    // (`max_passes` e `assignment_passes` ficaram sem uso por isso.)
    if (conv.assigned_to_user_id) continue;

    const next = await pickNextAssignee(admin, orgId, {});
    if (!next) {
      summary.left_unassigned += 1; // ninguém elegível — tenta no próximo tick
      continue;
    }
    await admin
      .from("conversations")
      .update({
        assigned_to_user_id: next,
        assigned_at: new Date(now).toISOString(),
        assignment_passes: 1,
      })
      .eq("id", conv.id)
      .eq("organization_id", orgId);
    await emitAlert(admin, orgId, "attendance.assigned", conv.id, { to_user_id: next });
    // AWAIT, nao `void`: ver a nota em assign.ts — aviso solto em serverless se
    // perde, e o cron termina logo depois de disparar.
    await notifyAssigneeNewLead(admin, {
      organizationId: orgId,
      conversationId: conv.id,
      assigneeUserId: next,
      kind: "assigned",
    });
    summary.reassigned += 1;
  }

}

export async function sweepAttendanceSla(
  admin: SupabaseClient,
  opts: { now?: Date } = {},
): Promise<SlaSweepSummary> {
  const summary = emptySummary();
  const now = (opts.now ?? new Date()).getTime();

  const { data: enabledOrgs, error } = await admin
    .from("attendance_settings")
    .select("organization_id")
    .eq("enabled", true);
  if (error) {
    summary.errors.push(`load_settings: ${error.message}`);
    return summary;
  }

  for (const row of (enabledOrgs ?? []) as { organization_id: string }[]) {
    const settings = await loadAttendanceSettings(admin, row.organization_id);
    if (!settings || !settings.enabled) continue;
    // Fora do expediente o tick pula a org: nada repassa/escala/alerta de
    // madrugada; o próximo tick dentro da janela retoma de onde parou.
    if (!inBusinessHours(settings.business_hours, new Date(now))) continue;
    summary.orgs_scanned += 1;
    try {
      await sweepOrg(admin, settings, now, summary);
    } catch (err) {
      summary.errors.push(`${row.organization_id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return summary;
}
