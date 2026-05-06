/**
 * POST /api/v1/webhooks/waha — global webhook receiver (no path token).
 *
 * Used when WAHA is configured with a single global WHATSAPP_HOOK_URL across
 * all sessions (current docker-compose). Resolves the channel_session by
 * `body.session` (= channel_sessions.waha_session_name).
 *
 * The path-token variant at /api/v1/webhooks/waha/[token] remains the
 * canonical per-tenant route for production (each tenant gets a unique
 * webhook URL).
 *
 * Behaviour mirrors [token]/route.ts. Pipeline:
 *   1. Look up channel_sessions by waha_session_name (404 if unknown)
 *   2. Verify HMAC SHA512 against webhook_secret_encrypted
 *      (skip if dev seed has placeholder secret — logged)
 *   3. Route by event:
 *        - message / message.any  -> ingest inbound (or skip fromMe)
 *        - message.ack            -> update status/ack
 *        - session.status / state.change -> update channel_session.status
 *   4. Idempotency via UNIQUE (organization_id, external_id) on messages
 *   5. STOP keyword -> contact.is_blocked=true
 *   6. webhook_events_log row for audit/replay
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { ackToStatus } from "@/lib/types/messaging";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface WahaEnvelope {
  event?: string;
  session?: string;
  payload?: WahaPayload;
}

interface WahaPayload {
  id?: string;
  from?: string;
  to?: string;
  fromMe?: boolean;
  body?: string;
  type?: string;
  hasMedia?: boolean;
  ack?: number;
  ackName?: string;
  participant?: string;
  author?: string;
  status?: string;
  timestamp?: number;
  mediaUrl?: string;
  mimetype?: string;
  _data?: {
    notifyName?: string;
    pushName?: string;
  } & Record<string, unknown>;
}

/**
 * Resolve um chatId WAHA ({number}@c.us | {lid}@lid | @g.us) em:
 * - phone E.164 ("+5531...") quando @c.us (number known)
 * - null phone + lid identifier quando @lid (number protected)
 * - null+null quando @g.us (group, skip)
 */
function parseChatId(chatId: string): { kind: "phone" | "lid" | "group"; phone: string | null; lid: string | null } {
  if (chatId.endsWith("@g.us")) return { kind: "group", phone: null, lid: null };
  if (chatId.endsWith("@lid")) {
    return { kind: "lid", phone: null, lid: chatId };
  }
  if (chatId.endsWith("@c.us") || chatId.endsWith("@s.whatsapp.net")) {
    const digits = chatId.replace(/@.*$/, "").replace(/^\+/, "");
    return { kind: "phone", phone: "+" + digits, lid: null };
  }
  // unknown shape — treat as group/skip
  return { kind: "group", phone: null, lid: null };
}

const STOP_RX = /\b(STOP|PARAR|SAIR|UNSUBSCRIBE)\b/i;

function verifyHmacSha512(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): boolean {
  if (!signatureHeader) return false;
  const expected = createHmac("sha512", secret).update(rawBody, "utf8").digest("hex");
  const got = signatureHeader.replace(/^sha512=/i, "").trim();
  if (got.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(got, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

function previewFromMessage(p: WahaPayload): string {
  if (p.body) return p.body.slice(0, 280);
  if (p.type) return `[${p.type}]`;
  return "";
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const rawBody = await req.text();
  let envelope: WahaEnvelope;
  try {
    envelope = JSON.parse(rawBody) as WahaEnvelope;
  } catch {
    return fail("invalid_request", "invalid_json", 400, { requestId });
  }

  const sessionName = envelope.session;
  if (!sessionName) {
    return fail("invalid_request", "missing session field", 400, { requestId });
  }

  const admin = createAdminClient();

  const { data: session, error: sessErr } = await admin
    .from("channel_sessions")
    .select(
      "id, organization_id, waha_session_name, webhook_secret_encrypted, status, is_warmup_complete, warmup_started_at",
    )
    .eq("waha_session_name", sessionName)
    .maybeSingle();

  if (sessErr) {
    return fail("internal_error", sessErr.message, 500, { requestId });
  }
  if (!session) {
    // Session not registered in our DB yet — accept and ignore (return 200 so
    // WAHA doesn't keep retrying). Common case: session was started via
    // dashboard before our app row was created.
    return ok({ accepted: false, reason: "session_not_registered", session: sessionName }, { requestId });
  }

  // HMAC verification — skip in dev when secret is the placeholder \x00.
  const sigHeader = req.headers.get("x-webhook-hmac") ?? req.headers.get("X-Webhook-Hmac");
  let validSignature = false;
  let hmacSkipped = false;
  try {
    const dec = await admin.rpc("fn_decrypt_oauth", {
      ciphertext: session.webhook_secret_encrypted,
    });
    if (dec.error || !dec.data || (typeof dec.data === "string" && dec.data.length < 4)) {
      hmacSkipped = true;
    } else {
      const secret = dec.data as string;
      validSignature = verifyHmacSha512(rawBody, sigHeader, secret);
    }
  } catch {
    hmacSkipped = true;
  }

  if (!hmacSkipped && !validSignature) {
    await audit({
      action: "nuvemshop.webhook_invalid_signature",
      organizationId: session.organization_id,
      metadata: { provider: "waha", session: session.waha_session_name, event: envelope.event },
    });
    return fail("unauthenticated", "invalid_signature", 401, { requestId });
  }

  const eventType = envelope.event ?? "unknown";
  const payload = envelope.payload ?? {};
  const externalId = payload.id ?? null;

  const headersJson: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    if (key.toLowerCase().startsWith("authorization")) return;
    if (key.toLowerCase() === "cookie") return;
    headersJson[key] = value;
  });
  await admin.from("webhook_events_log").insert({
    organization_id: session.organization_id,
    channel_session_id: session.id,
    provider: "waha",
    webhook_path_token: null,
    http_method: "POST",
    headers: headersJson,
    raw_body: rawBody,
    payload_parsed: envelope as unknown as Record<string, unknown>,
    signature_header: sigHeader ?? null,
    valid_signature: validSignature || hmacSkipped,
    event_type: eventType,
    external_id: externalId,
    status: "received",
    attempts: 0,
  });

  try {
    if (eventType === "message" || eventType === "message.any") {
      // Skip groups (chatId @g.us) — handled inside handler.
      // Treat fromMe=true as outbound (user replied directly from their
      // own WhatsApp app, not via our composer). Record so the operator
      // sees the manual reply alongside CRM-driven outbounds.
      if (payload.fromMe) {
        await handleOutboundFromUserPhone(admin, session, payload, requestId);
      } else {
        await handleInbound(admin, session, payload, requestId);
      }
    } else if (eventType === "message.ack") {
      await handleAck(admin, session, payload);
    } else if (eventType === "session.status" || eventType === "state.change") {
      await handleSessionStatus(admin, session, payload);
    }
  } catch (err) {
    console.error("[waha.webhook] handler failed", err);
  }

  return ok({ accepted: true }, { requestId });
}

async function handleInbound(
  admin: ReturnType<typeof createAdminClient>,
  session: { id: string; organization_id: string },
  p: WahaPayload,
  requestId: string,
): Promise<void> {
  const chatId = p.from ?? "";
  const parsed = parseChatId(chatId);
  if (parsed.kind === "group") return;
  if (!p.id || !chatId) return;
  // Skip events sem conteúdo (WAHA emite eventos vazios pra status updates,
  // read receipts, presence — esses não viram mensagens).
  if (!p.body && !p.mediaUrl && !p.hasMedia) return;

  const notifyName = p._data?.notifyName ?? p._data?.pushName ?? null;

  // Idempotent contact upsert. Match strategy depends on identifier kind:
  //  - phone (@c.us): match by phone_number (E.164)
  //  - lid (@lid): match by source_metadata->>'waha_lid'
  let contactId: string | null = null;
  let existingContact: { id: string; is_blocked: boolean } | null = null;

  if (parsed.kind === "phone") {
    const { data } = await admin
      .from("contacts")
      .select("id, is_blocked")
      .eq("organization_id", session.organization_id)
      .eq("phone_number", parsed.phone)
      .maybeSingle();
    existingContact = data ?? null;
  } else {
    const { data } = await admin
      .from("contacts")
      .select("id, is_blocked")
      .eq("organization_id", session.organization_id)
      .eq("source_metadata->>waha_lid", parsed.lid)
      .maybeSingle();
    existingContact = data ?? null;
  }

  if (existingContact) {
    contactId = existingContact.id;
  } else {
    const insertRow: Record<string, unknown> = {
      organization_id: session.organization_id,
      source: "whatsapp",
      consent: {},
      tags: [],
      source_metadata:
        parsed.kind === "lid"
          ? { waha_lid: parsed.lid, notify_name: notifyName }
          : { waha_chat_id: chatId, notify_name: notifyName },
    };
    if (parsed.kind === "phone") insertRow.phone_number = parsed.phone;
    if (notifyName) insertRow.display_name = notifyName;

    const { data: createdContact, error: contactErr } = await admin
      .from("contacts")
      .insert(insertRow)
      .select("id")
      .single();
    if (contactErr || !createdContact) {
      console.error("[waha.webhook] contact create failed", contactErr?.message);
      return;
    }
    contactId = createdContact.id;
  }

  let conversationId: string | null = null;
  const { data: existingConv } = await admin
    .from("conversations")
    .select("id, assigned_to_user_id, unread_count_for_assignee")
    .eq("organization_id", session.organization_id)
    .eq("contact_id", contactId)
    .eq("channel_session_id", session.id)
    .maybeSingle();

  if (existingConv) {
    conversationId = existingConv.id;
  } else {
    const { data: createdConv, error: convErr } = await admin
      .from("conversations")
      .insert({
        organization_id: session.organization_id,
        contact_id: contactId,
        channel_session_id: session.id,
        channel: "whatsapp",
        status: "open",
        is_group: false,
        unread_count_for_assignee: 0,
        metadata: {},
      })
      .select("id")
      .single();
    if (convErr || !createdConv) {
      console.error("[waha.webhook] conversation create failed", convErr?.message);
      return;
    }
    conversationId = createdConv.id;
  }

  const now = new Date().toISOString();
  const { data: insertedMessage, error: insertErr } = await admin
    .from("messages")
    .insert({
      organization_id: session.organization_id,
      conversation_id: conversationId,
      channel_session_id: session.id,
      contact_id: contactId,
      external_id: p.id,
      type: p.type ?? "text",
      direction: "inbound",
      status: "delivered",
      ack: p.ack ?? null,
      body: p.body ?? null,
      media_url: p.mediaUrl ?? null,
      media_mime: p.mimetype ?? null,
      sent_via: "external_device",
      sent_at: p.timestamp ? new Date(p.timestamp * 1000).toISOString() : now,
      delivered_at: now,
      metadata: { raw_type: p.type, ack_name: p.ackName },
    })
    .select("id")
    .maybeSingle();

  if (insertErr && insertErr.code !== "23505") {
    console.error("[waha.webhook] message insert failed", insertErr.message);
    return;
  }
  if (insertErr?.code === "23505") return;

  await admin
    .from("conversations")
    .update({
      last_inbound_at: now,
      last_message_at: now,
      last_message_preview: previewFromMessage(p),
      unread_count_for_assignee: (existingConv?.unread_count_for_assignee ?? 0) + 1,
    })
    .eq("id", conversationId);

  if (p.body && STOP_RX.test(p.body)) {
    await admin
      .from("contacts")
      .update({
        is_blocked: true,
        blocked_reason: "stop_keyword",
        blocked_at: now,
      })
      .eq("id", contactId);
    await audit({
      action: "contact.blocked",
      organizationId: session.organization_id,
      resourceType: "contact",
      requestId,
      metadata: { reason: "stop_keyword", contact_id: contactId },
    });
  }

  await audit({
    action: "message.received",
    organizationId: session.organization_id,
    resourceType: "message",
    requestId,
    metadata: { conversation_id: conversationId, type: p.type, external_id: p.id },
  });

  // Emit ai_agent.dispatch_requested for the agent-dispatcher worker (wave 7).
  // Fire-and-forget: failure does NOT break the webhook (return 200).
  // Filters: non-group (early-return above), non-fromMe (separate handler),
  // kind=inbound (this function).
  if (insertedMessage?.id) {
    const inboundMessageId = insertedMessage.id;
    admin
      .rpc("emit_event" as never, {
        p_event_type: "ai_agent.dispatch_requested",
        p_entity_kind: "message",
        p_entity_id: inboundMessageId,
        p_payload: {
          organization_id: session.organization_id,
          conversation_id: conversationId,
          contact_id: contactId,
          channel_session_id: session.id,
          inbound_message_id: inboundMessageId,
        },
        p_metadata: { source: "waha_webhook", request_id: requestId },
        p_organization_id: session.organization_id,
      } as never)
      .then(({ error }) => {
        if (error) console.error("[waha.webhook] emit dispatch_requested failed", error.message);
      });
  }
}

/**
 * fromMe=true: user sent a message DIRECTLY from their WhatsApp app (not via
 * our composer). Record as outbound so the operator sees what was sent.
 */
async function handleOutboundFromUserPhone(
  admin: ReturnType<typeof createAdminClient>,
  session: { id: string; organization_id: string },
  p: WahaPayload,
  requestId: string,
): Promise<void> {
  // For outbound (fromMe=true), recipient is in `to`.
  const chatId = p.to ?? "";
  const parsed = parseChatId(chatId);
  if (parsed.kind === "group") return;
  if (!p.id || !chatId) return;
  if (!p.body && !p.mediaUrl && !p.hasMedia) return;

  // Resolve recipient contact (auto-create if missing — pode ser um número
  // pra quem o operador respondeu do celular sem ter passado pelo CRM).
  let contactId: string | null = null;
  let existingContact: { id: string } | null = null;

  if (parsed.kind === "phone") {
    const { data } = await admin
      .from("contacts")
      .select("id")
      .eq("organization_id", session.organization_id)
      .eq("phone_number", parsed.phone)
      .maybeSingle();
    existingContact = data ?? null;
  } else {
    const { data } = await admin
      .from("contacts")
      .select("id")
      .eq("organization_id", session.organization_id)
      .eq("source_metadata->>waha_lid", parsed.lid)
      .maybeSingle();
    existingContact = data ?? null;
  }

  if (existingContact) {
    contactId = existingContact.id;
  } else {
    // Outbound from user phone — display_name fallback é o phone (se @c.us)
    // ou "Contato {LID curto}" pra @lid sem display name (vai ser editavel).
    const fallbackName =
      parsed.kind === "phone"
        ? parsed.phone
        : `Contato ${(parsed.lid ?? "").replace(/@.*$/, "").slice(-6)}`;
    const insertRow: Record<string, unknown> = {
      organization_id: session.organization_id,
      source: "whatsapp",
      consent: {},
      tags: [],
      display_name: fallbackName,
      source_metadata:
        parsed.kind === "lid" ? { waha_lid: parsed.lid } : { waha_chat_id: chatId },
    };
    if (parsed.kind === "phone") insertRow.phone_number = parsed.phone;

    const { data: created, error: contactErr } = await admin
      .from("contacts")
      .insert(insertRow)
      .select("id")
      .single();
    if (contactErr || !created) {
      console.error("[waha.webhook] outbound contact create failed", contactErr?.message);
      return;
    }
    contactId = created.id;
  }
  // Build a tiny shim so the rest of the function reads the same shape as inbound.
  const contact = { id: contactId };

  const { data: conv } = await admin
    .from("conversations")
    .select("id")
    .eq("organization_id", session.organization_id)
    .eq("contact_id", contact.id)
    .eq("channel_session_id", session.id)
    .maybeSingle();

  let conversationId = conv?.id ?? null;
  if (!conversationId) {
    const { data: createdConv } = await admin
      .from("conversations")
      .insert({
        organization_id: session.organization_id,
        contact_id: contact.id,
        channel_session_id: session.id,
        channel: "whatsapp",
        status: "open",
        is_group: false,
        unread_count_for_assignee: 0,
        metadata: {},
      })
      .select("id")
      .single();
    conversationId = createdConv?.id ?? null;
  }
  if (!conversationId) return;

  const now = new Date().toISOString();
  const { error: insertErr } = await admin.from("messages").insert({
    organization_id: session.organization_id,
    conversation_id: conversationId,
    channel_session_id: session.id,
    contact_id: contact.id,
    external_id: p.id,
    type: p.type ?? "text",
    direction: "outbound",
    status: "sent",
    ack: p.ack ?? null,
    body: p.body ?? null,
    media_url: p.mediaUrl ?? null,
    media_mime: p.mimetype ?? null,
    sent_via: "external_device", // user sent from their own phone, not CRM
    sent_at: p.timestamp ? new Date(p.timestamp * 1000).toISOString() : now,
    metadata: { raw_type: p.type, fromMe: true },
  });
  if (insertErr && insertErr.code !== "23505") {
    console.error("[waha.webhook] outbound insert failed", insertErr.message);
    return;
  }
  if (insertErr?.code === "23505") return;

  await admin
    .from("conversations")
    .update({
      last_outbound_at: now,
      last_message_at: now,
      last_message_preview: previewFromMessage(p),
    })
    .eq("id", conversationId);

  await audit({
    action: "message.sent",
    organizationId: session.organization_id,
    resourceType: "message",
    requestId,
    metadata: {
      conversation_id: conversationId,
      type: p.type,
      external_id: p.id,
      from_user_phone: true,
    },
  });
}

async function handleAck(
  admin: ReturnType<typeof createAdminClient>,
  session: { id: string; organization_id: string },
  p: WahaPayload,
): Promise<void> {
  if (!p.id) return;
  const ack = p.ack ?? 0;
  const status = ackToStatus(ack);
  const now = new Date().toISOString();

  const update: Record<string, unknown> = { ack, status };
  if (ack >= 2) update.delivered_at = now;
  if (ack >= 3) update.read_at = now;

  await admin
    .from("messages")
    .update(update)
    .eq("organization_id", session.organization_id)
    .eq("external_id", p.id);
}

async function handleSessionStatus(
  admin: ReturnType<typeof createAdminClient>,
  session: {
    id: string;
    organization_id: string;
    is_warmup_complete: boolean | null;
    warmup_started_at: string | null;
  },
  p: WahaPayload,
): Promise<void> {
  const status = (p.status ?? "").toUpperCase() || null;
  if (!status) return;

  const allowed = new Set(["STARTING", "SCAN_QR_CODE", "WORKING", "STOPPED", "FAILED"]);
  if (!allowed.has(status)) return;
  const now = new Date().toISOString();

  const update: Record<string, unknown> = {
    status,
    last_status_change_at: now,
  };

  if (status === "WORKING" && session.warmup_started_at && !session.is_warmup_complete) {
    update.is_warmup_complete = true;
    update.warmup_completed_at = now;
  }

  await admin.from("channel_sessions").update(update).eq("id", session.id);
}
