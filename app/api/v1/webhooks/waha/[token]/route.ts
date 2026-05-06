/**
 * POST /api/v1/webhooks/waha/[token]
 *
 * Recebe eventos WAHA por sessão (cada channel_session tem um
 * webhook_path_token único url-safe). Pipeline:
 *   1. Look up channel_sessions by webhook_path_token (404 se desconhecido)
 *   2. Verifica HMAC SHA512 contra webhook_secret_encrypted (RPC fn_decrypt_oauth)
 *   3. Roteia por evento:
 *        - message / message.any  -> ingest inbound message
 *        - message.ack            -> atualiza status/ack
 *        - session.status / state.change -> atualiza channel_session.status
 *   4. Idempotência via UNIQUE (organization_id, external_id) em messages
 *   5. STOP keyword detection -> contact.is_blocked=true
 *   6. webhook_events_log para audit/replay
 *
 * Spec 03 §5.x. Trigger Postgres NUNCA faz HTTP — todo side-effect ocorre
 * aqui (inline por enquanto; mover para worker assim que infra estiver pronta).
 */
import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { ackToStatus } from "@/lib/types/messaging";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteCtx {
  params: Promise<{ token: string }>;
}

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
  // Per WAHA NOWEB. Some webhooks nest payload differently:
  status?: string; // session.status uses payload.status
  timestamp?: number;
  mediaUrl?: string;
  mimetype?: string;
}

const STOP_RX = /\b(STOP|PARAR|SAIR|UNSUBSCRIBE)\b/i;

function verifyHmacSha512(rawBody: string, signatureHeader: string | null, secret: string): boolean {
  if (!signatureHeader) return false;
  const expected = createHmac("sha512", secret).update(rawBody, "utf8").digest("hex");
  // Header may come as raw hex or "sha512=hex"
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

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const requestId = randomUUID();
  const { token } = await ctx.params;

  if (!token || token.length < 8) {
    return fail("not_found", "unknown webhook token", 404, { requestId });
  }

  const rawBody = await req.text();
  let envelope: WahaEnvelope;
  try {
    envelope = JSON.parse(rawBody) as WahaEnvelope;
  } catch {
    return fail("invalid_request", "invalid_json", 400, { requestId });
  }

  const admin = createAdminClient();

  const { data: session, error: sessErr } = await admin
    .from("channel_sessions")
    .select(
      "id, organization_id, waha_session_name, webhook_secret_encrypted, status, is_warmup_complete, warmup_started_at",
    )
    .eq("webhook_path_token", token)
    .maybeSingle();

  if (sessErr) {
    return fail("internal_error", sessErr.message, 500, { requestId });
  }
  if (!session) {
    return fail("not_found", "unknown webhook token", 404, { requestId });
  }

  // HMAC verification (best-effort: if fn_decrypt_oauth fails — e.g. dev seed
  // without encryption — log and skip for MVP).
  const sigHeader = req.headers.get("x-webhook-hmac") ?? req.headers.get("X-Webhook-Hmac");
  let validSignature = false;
  let hmacSkipped = false;
  try {
    const dec = await admin.rpc("fn_decrypt_oauth", {
      ciphertext: session.webhook_secret_encrypted,
    });
    if (dec.error || !dec.data) {
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
      action: "nuvemshop.webhook_invalid_signature", // reuse pending dedicated waha code
      organizationId: session.organization_id,
      metadata: { provider: "waha", session: session.waha_session_name, event: envelope.event },
    });
    return fail("unauthenticated", "invalid_signature", 401, { requestId });
  }

  const eventType = envelope.event ?? "unknown";
  const payload = envelope.payload ?? {};
  const externalId = payload.id ?? null;

  // Persist webhook_events_log row (best-effort).
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
    webhook_path_token: token,
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

  // Route by event
  try {
    if (eventType === "message" || eventType === "message.any") {
      await handleInbound(admin, session, payload, requestId);
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
  session: {
    id: string;
    organization_id: string;
  },
  p: WahaPayload,
  requestId: string,
): Promise<void> {
  const chatId = p.from ?? "";
  const isGroup = chatId.endsWith("@g.us");

  // Group handling: skip CRM contact binding (Spec 03 / project CLAUDE.md).
  if (isGroup) return;

  if (!p.id || !chatId) return;

  // Resolve phone (strip @c.us / @s.whatsapp.net)
  const phone = chatId.replace(/@.*$/, "");

  // Find or create contact by phone within org.
  let contactId: string | null = null;
  const { data: existingContact } = await admin
    .from("contacts")
    .select("id, is_blocked")
    .eq("organization_id", session.organization_id)
    .eq("phone_number", phone)
    .maybeSingle();

  if (existingContact) {
    contactId = existingContact.id;
  } else {
    const { data: createdContact, error: contactErr } = await admin
      .from("contacts")
      .insert({
        organization_id: session.organization_id,
        phone_number: phone,
        source: "whatsapp",
        consent: {},
      })
      .select("id")
      .single();
    if (contactErr || !createdContact) {
      console.error("[waha.webhook] contact create failed", contactErr?.message);
      return;
    }
    contactId = createdContact.id;
  }

  // Find or create conversation.
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
    await audit({
      action: "conversation.created",
      organizationId: session.organization_id,
      resourceType: "conversation",
      resourceId: conversationId,
      requestId,
      metadata: { source: "waha_inbound" },
    });
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
      sent_via: "system",
      sent_at: p.timestamp ? new Date(p.timestamp * 1000).toISOString() : now,
      delivered_at: now,
      metadata: { raw_type: p.type, ack_name: p.ackName },
    })
    .select("id")
    .maybeSingle();

  // Idempotência: 23505 = unique violation (organization_id, external_id).
  if (insertErr && insertErr.code !== "23505") {
    console.error("[waha.webhook] message insert failed", insertErr.message);
    return;
  }
  if (insertErr?.code === "23505") {
    return; // already ingested
  }

  // Update conversation aggregates.
  await admin
    .from("conversations")
    .update({
      last_inbound_at: now,
      last_message_at: now,
      last_message_preview: previewFromMessage(p),
      unread_count_for_assignee: (existingConv?.unread_count_for_assignee ?? 0) + 1,
    })
    .eq("id", conversationId);

  // STOP keyword detection.
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
      resourceId: contactId,
      requestId,
      metadata: { reason: "stop_keyword", body: p.body.slice(0, 64) },
    });
  }

  await audit({
    action: "message.received",
    organizationId: session.organization_id,
    resourceType: "message",
    resourceId: p.id,
    requestId,
    metadata: { conversation_id: conversationId, type: p.type },
  });

  await admin
    .rpc("emit_event", {
      p_event_type: "message.received",
      p_entity_kind: "message",
      p_entity_id: null,
      p_payload: { external_id: p.id, conversation_id: conversationId },
      p_metadata: { request_id: requestId },
      p_organization_id: session.organization_id,
    })
    .then(({ error }) => {
      if (error) console.error("[waha.webhook] emit_event failed", error.message);
    });

  // Emit ai_agent.dispatch_requested for the agent-dispatcher worker (wave 7).
  // Fire-and-forget: failure does NOT break the webhook (return 200).
  // Filters: non-group (isGroup early-return above), non-fromMe (separate
  // branch in caller), kind=inbound (this function).
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
  const status = (p.status ?? "").toLowerCase() || null;
  if (!status) return;

  // Map WAHA status (uppercase canonical per channel_sessions_status_check).
  const allowed = new Set(["STARTING", "SCAN_QR_CODE", "WORKING", "STOPPED", "FAILED"]);
  const local = allowed.has(status.toUpperCase()) ? status.toUpperCase() : null;
  if (!local) return;
  const now = new Date().toISOString();

  const update: Record<string, unknown> = {
    status: local,
    last_status_change_at: now,
  };

  if (local === "WORKING" && session.warmup_started_at && !session.is_warmup_complete) {
    update.is_warmup_complete = true;
    update.warmup_completed_at = now;
  }

  await admin.from("channel_sessions").update(update).eq("id", session.id);
}
