/**
 * C4 (notificação) — avisa o corretor por WhatsApp quando um lead é atribuído
 * a ele (handoff/rodízio) ou repassado (SLA). Corretor é mobile-first e vive no
 * WhatsApp; a presença por aba aberta (0028) não alcança ele, o ping sim.
 *
 * Envia DIRETO via WAHA (`sendWAHA`), sem passar pelo pipeline de persistência
 * — este aviso interno NÃO deve virar conversa/mensagem no inbox do tenant.
 * Fire-and-forget: qualquer falha aqui nunca pode derrubar a atribuição.
 *
 * Conteúdo do aviso (pedido do cliente): nome do lead, link clicável pro
 * WhatsApp do lead (wa.me), resumo da conversa gerado pela IA (C2) e o imóvel
 * de interesse vinculado (C3). Degrada com elegância se algum dado faltar.
 *
 * ⚠️ Limitação conhecida: o aviso sai do MESMO número do tenant (sessão WAHA).
 * Se o corretor responder nesse número, o webhook cria uma conversa. Aceitável
 * no piloto; futuramente usar uma sessão dedicada a notificações internas.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { sendPushToUser } from "@/lib/push/send";
import { resolveChatIdChecked, sendWAHA } from "@/lib/waha/send";

export type NotifyKind = "assigned" | "reassigned" | "escalated" | "sla_alert";

function formatBRL(cents: number | null, currency: string | null): string {
  if (cents == null) return "";
  const cur = currency ?? "BRL";
  try {
    return new Intl.NumberFormat("pt-BR", { style: "currency", currency: cur }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${cur}`;
  }
}

interface LinkedProperty {
  title: string;
  location: string | null;
  price_cents: number | null;
  currency: string | null;
  url: string | null;
}

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
    // 1) Contato do lead: nome + telefone (p/ montar o link clicável do WhatsApp).
    const { data: conv } = await admin
      .from("conversations")
      .select("id, contact_id, contacts:contact_id(display_name, phone_number)")
      .eq("id", args.conversationId)
      .maybeSingle();
    const contactId = (conv as { contact_id: string | null } | null)?.contact_id ?? null;
    const contact = (conv as unknown as {
      contacts: { display_name: string | null; phone_number: string | null } | null;
    } | null)?.contacts;
    const contactName = contact?.display_name || contact?.phone_number || "Novo contato";
    let leadPhone = contact?.phone_number ?? null;
    // Fallback p/ contatos @lid: o WhatsApp oculta o número no contato (LID), mas o
    // número real vem no wa_key da última mensagem inbound (o ingest guarda em
    // messages.metadata.wa_key — remoteJidAlt/senderPn tipo "5531...@s.whatsapp.net").
    // Sem isto a notificação sai sem o link clicável pro WhatsApp do lead.
    if (!leadPhone) {
      const { data: lastIn } = await admin
        .from("messages")
        .select("metadata")
        .eq("organization_id", args.organizationId)
        .eq("conversation_id", args.conversationId)
        .eq("direction", "inbound")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const key = (lastIn as { metadata?: { wa_key?: Record<string, unknown> } } | null)?.metadata
        ?.wa_key;
      if (key) {
        for (const f of ["senderPn", "remoteJidAlt", "participantPn", "participantAlt"] as const) {
          const raw = key[f];
          if (typeof raw === "string") {
            const m = raw.match(/^(\d{6,15})@/);
            if (m) {
              leadPhone = "+" + m[1];
              break;
            }
          }
        }
      }
    }
    // wa.me só com dígitos (sem "+"): o corretor toca e abre a conversa com o lead.
    const waLink = leadPhone ? `https://wa.me/${leadPhone.replace(/\D/g, "")}` : null;

    // 2) Lead do contato: `description` = resumo do interesse escrito pela IA (C2);
    //    `id` p/ buscar o imóvel de interesse (C3).
    let leadId: string | null = null;
    let leadDescription: string | null = null;
    // Reserva pro bloco do imóvel: o bot quase nunca chama crm_link_lead_product,
    // então crm_lead_products vem vazio e o corretor recebia aviso sem saber de
    // QUAL imóvel se tratava (reclamação do Darlei em 03/09/2026). O título do
    // lead já carrega o interesse ("Marina — Apto 2 qts Santa Amélia", formato
    // que o próprio prompt manda usar) e o value_cents o preço. Servem de rede.
    let leadTitle: string | null = null;
    let leadValueCents: number | null = null;
    if (contactId) {
      const { data: lead } = await admin
        .from("crm_leads")
        .select("id, description, title, value_cents")
        .eq("organization_id", args.organizationId)
        .eq("contact_id", contactId)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      leadId = (lead as { id: string } | null)?.id ?? null;
      leadDescription = (lead as { description: string | null } | null)?.description ?? null;
      const l = lead as { title: string | null; value_cents: number | null } | null;
      leadTitle = l?.title ?? null;
      leadValueCents = l?.value_cents ?? null;
    }

    // 3) Fallback do resumo: última mensagem do lead, se a IA ainda não resumiu.
    let interest = "";
    if (!leadDescription) {
      const { data: lastMsg } = await admin
        .from("messages")
        .select("body")
        .eq("organization_id", args.organizationId)
        .eq("conversation_id", args.conversationId)
        .eq("direction", "inbound")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      interest = ((lastMsg as { body: string | null } | null)?.body ?? "").trim().slice(0, 140);
    }
    const resumo = (leadDescription?.trim() || interest).slice(0, 320);

    // 4) Imóvel de interesse vinculado ao lead (C3), o mais recente.
    let property: LinkedProperty | null = null;
    if (leadId) {
      const { data: lp } = await admin
        .from("crm_lead_products")
        .select("product:crm_products(title, location, price_cents, currency, url)")
        // organization_id explícito: o admin client ignora RLS (doutrina do CLAUDE.md).
        // O lead_id já é tenant-scoped, então isto é trava redundante, e é de propósito.
        .eq("organization_id", args.organizationId)
        .eq("lead_id", leadId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const p = (lp as unknown as { product: LinkedProperty | LinkedProperty[] | null } | null)?.product;
      property = Array.isArray(p) ? (p[0] ?? null) : (p ?? null);
    }

    const header =
      args.kind === "sla_alert"
        ? "🚨 Lead assumido e sem resposta — cobre o atendimento"
        : args.kind === "escalated"
          ? "⚠️ Lead sem atendimento — assumiu o comando"
          : args.kind === "reassigned"
            ? "🔁 Lead repassado pra você"
            : "🔔 Novo lead pra você";

    // 5) Push nativo (PWA) — independente do WhatsApp; noop sem VAPID/assinatura.
    const pushExtra = property?.title
      ? ` · 🏠 ${property.title}`
      : leadTitle
      ? ` · 🏠 ${leadTitle}`
      : resumo
        ? ` — "${resumo.slice(0, 90)}"`
        : "";
    const pushed = await sendPushToUser(admin, args.organizationId, args.assigneeUserId, {
      title: header,
      body: `${contactName}${pushExtra}`,
      url: `/app/inbox/${args.conversationId}`,
      tag: `lead-${args.conversationId}`,
    });

    // 6) WhatsApp — gate por tenant.
    const { data: settings } = await admin
      .from("attendance_settings")
      .select("notify_whatsapp")
      .eq("organization_id", args.organizationId)
      .maybeSingle();
    if (settings && (settings as { notify_whatsapp: boolean }).notify_whatsapp === false) {
      return pushed > 0;
    }

    // 7) Número do corretor (WhatsApp pessoal de avisos).
    const { data: member } = await admin
      .from("user_organizations")
      .select("notify_whatsapp_e164")
      .eq("organization_id", args.organizationId)
      .eq("user_id", args.assigneeUserId)
      .is("revoked_at", null)
      .maybeSingle();
    const phone = (member as { notify_whatsapp_e164: string | null } | null)?.notify_whatsapp_e164;
    if (!phone) return pushed > 0; // sem número cadastrado → só o push

    // 8) Sessão WAHA do tenant que envia (a WORKING mais recente).
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

    // 9) Monta a mensagem rica: nome + link WhatsApp + resumo IA + imóvel.
    const base = (env.NEXT_PUBLIC_APP_URL || "https://crm.zapinbox.com.br").replace(/\/$/, "");
    const crmLink = `${base}/app/inbox/${args.conversationId}`;
    const lines: string[] = [header, "", `👤 *${contactName}*`];
    if (waLink) lines.push(`💬 Falar no WhatsApp: ${waLink}`);
    if (resumo) lines.push("", "📋 Resumo (IA):", resumo);
    if (property?.title) {
      const loc = property.location ? ` — ${property.location}` : "";
      const price =
        property.price_cents != null ? ` · ${formatBRL(property.price_cents, property.currency)}` : "";
      lines.push("", "🏠 Imóvel de interesse:", `${property.title}${loc}${price}`);
      if (property.url) lines.push(property.url);
    } else if (leadTitle) {
      // Rede: sem imóvel VINCULADO (o bot quase nunca chama crm_link_lead_product,
      // então crm_lead_products vem vazio), o título do lead já diz o interesse —
      // o prompt manda escrever "Nome — Apto 2 qts Santa Amélia". Sem isto o
      // corretor recebia o aviso sem saber de qual imóvel se tratava.
      const price = leadValueCents != null ? ` · ${formatBRL(leadValueCents, "BRL")}` : "";
      lines.push("", "🏠 Interesse (do lead):", `${leadTitle}${price}`);
    }
    lines.push("", "📲 Abrir no CRM:", crmLink);
    const text = lines.join("\n");

    // 10) Envia direto (sem persistir no inbox).
    // CONFERINDO no WhatsApp qual e o chatId real. O numero do corretor foi
    // digitado a mao, e conta brasileira antiga tem JID sem o nono digito: em
    // 03/09/2026 as 31 notificacoes do dia sairam pra 5531992953088@c.us
    // quando o JID verdadeiro era 553192953088@c.us. A tela mostrava
    // "enviada", o eco voltava pelo webhook, e nenhum corretor recebeu nada.
    const chatId = await resolveChatIdChecked({ sessionName, phoneNumber: phone });
    if (!chatId) {
      logger.warn("[attendance.notify] numero do corretor nao esta no WhatsApp", {
        organization_id: args.organizationId,
        assignee_user_id: args.assigneeUserId,
      });
      return pushed > 0;
    }
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
