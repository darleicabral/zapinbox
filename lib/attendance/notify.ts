/**
 * C4 (notificação) — avisa o corretor por WhatsApp quando um lead é atribuído
 * a ele (handoff/rodízio) ou repassado (SLA). Corretor é mobile-first e vive no
 * WhatsApp; a presença por aba aberta (0028) não alcança ele, o ping sim.
 *
 * Envia DIRETO via WAHA (`sendWAHA`), sem passar pelo pipeline de persistência
 * — este aviso interno NÃO deve virar conversa/mensagem no inbox do tenant.
 * Fire-and-forget: qualquer falha aqui nunca pode derrubar a atribuição.
 *
 * ⚠️ Limitação conhecida: o aviso sai do MESMO número do tenant (sessão WAHA).
 * Se o corretor responder nesse número, o webhook cria uma conversa. Aceitável
 * no piloto; futuramente usar uma sessão dedicada a notificações internas.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { sendPushToUser } from "@/lib/push/send";
import { resolveWahaChatId, sendWAHA } from "@/lib/waha/send";

export type NotifyKind = "assigned" | "reassigned" | "escalated" | "sla_alert";

export async function notifyAssigneeNewLead(
  admin: SupabaseClient,
  args: {
    organizationId: string;
    conversationId: string;
    assigneeUserId: string;
    kind: NotifyKind;
  },
): Promise<boolean> {
  try {
    // 1) Resumo do lead: nome do contato + última mensagem inbound (interesse).
    //    Usado pelos DOIS canais (push nativo + WhatsApp).
    const { data: conv } = await admin
      .from("conversations")
      .select("id, contacts:contact_id(display_name, phone_number)")
      .eq("id", args.conversationId)
      .maybeSingle();
    const contact = (conv as unknown as {
      contacts: { display_name: string | null; phone_number: string | null } | null;
    } | null)?.contacts;
    const contactName = contact?.display_name || contact?.phone_number || "Novo contato";

    const { data: lastMsg } = await admin
      .from("messages")
      .select("body")
      .eq("organization_id", args.organizationId)
      .eq("conversation_id", args.conversationId)
      .eq("direction", "inbound")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const interest = ((lastMsg as { body: string | null } | null)?.body ?? "").trim().slice(0, 140);

    const header =
      args.kind === "sla_alert"
        ? "🚨 Lead assumido e sem resposta — cobre o atendimento"
        : args.kind === "escalated"
          ? "⚠️ Lead sem atendimento — assumiu o comando"
          : args.kind === "reassigned"
            ? "🔁 Lead repassado pra você"
            : "🔔 Novo lead pra você";

    // 2) Push nativo (PWA) — independente do canal WhatsApp; noop sem VAPID
    //    ou sem assinatura deste usuário.
    const pushed = await sendPushToUser(admin, args.organizationId, args.assigneeUserId, {
      title: header,
      body: `${contactName}${interest ? ` — "${interest}"` : ""}`,
      url: `/app/inbox/${args.conversationId}`,
      tag: `lead-${args.conversationId}`,
    });

    // 3) WhatsApp — gate por tenant.
    const { data: settings } = await admin
      .from("attendance_settings")
      .select("notify_whatsapp")
      .eq("organization_id", args.organizationId)
      .maybeSingle();
    if (settings && (settings as { notify_whatsapp: boolean }).notify_whatsapp === false) {
      return pushed > 0;
    }

    // 4) Número do corretor.
    const { data: member } = await admin
      .from("user_organizations")
      .select("notify_whatsapp_e164")
      .eq("organization_id", args.organizationId)
      .eq("user_id", args.assigneeUserId)
      .is("revoked_at", null)
      .maybeSingle();
    const phone = (member as { notify_whatsapp_e164: string | null } | null)?.notify_whatsapp_e164;
    if (!phone) return pushed > 0; // sem número cadastrado → só o push

    // 5) Sessão WAHA do tenant que envia (a WORKING mais recente).
    const { data: session } = await admin
      .from("channel_sessions")
      .select("waha_session_name, status, created_at")
      .eq("organization_id", args.organizationId)
      .eq("status", "WORKING")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const sessionName = (session as { waha_session_name: string } | null)?.waha_session_name;
    if (!sessionName) return pushed > 0;

    // 6) Texto + deep link.
    const base = (env.NEXT_PUBLIC_APP_URL || "https://crm.zapinbox.com.br").replace(/\/$/, "");
    const link = `${base}/app/inbox/${args.conversationId}`;
    const text = `${header}\n\n👤 ${contactName}${interest ? `\n💬 "${interest}"` : ""}\n\nAbrir e atender:\n${link}`;

    // 7) Envia direto (sem persistir).
    const chatId = resolveWahaChatId({
      isGroup: false,
      groupChatId: null,
      phoneNumber: phone,
      waIdentity: null,
    });
    if (!chatId) return pushed > 0;
    const res = await sendWAHA({ sessionName, chatId, text });
    return res !== null || pushed > 0; // null = WAHA não configurado (noop)
  } catch (err) {
    logger.warn("[attendance.notify] falhou (ignorado)", {
      organization_id: args.organizationId,
      conversation_id: args.conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
