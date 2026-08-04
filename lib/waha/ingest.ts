/**
 * lib/waha/ingest.ts — pipeline de ingestão WAHA compartilhado pelos dois route
 * handlers de webhook (`/waha` global e `/waha/[token]` per-tenant).
 *
 * Fonte única da verdade para: parse de identidade WhatsApp, resolução de
 * contato/conversa e persistência de mensagem. Resolução é ATÔMICA via RPC
 * (fn_upsert_wa_contact / fn_upsert_wa_conversation) — o padrão check-then-act
 * antigo criava um contato/conversa novo a cada mensagem porque o WAHA NOWEB
 * emite `message` E `message.any` para a mesma mensagem (corrida). Ver migration
 * 0027 para o modelo de identidade canônica.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { after } from "next/server";

import { audit } from "@/lib/audit";
import { dispatchAgents } from "@/lib/ai/dispatcher";
import { hasPosvendaModule } from "@/lib/modules";
import { sendPushToOrg } from "@/lib/push/send";
import type { createAdminClient } from "@/lib/supabase/admin";
import { ackToStatus } from "@/lib/types/messaging";

type Admin = ReturnType<typeof createAdminClient>;

interface Session {
  id: string;
  organization_id: string;
  /** Número pareado, só dígitos como o WAHA devolve. Usado p/ ignorar o
   *  "chat consigo mesmo" (ver handleOutboundFromUserPhone). */
  phone_number?: string | null;
}

export interface WahaPayload {
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
  /** WAHA novo aninha a mídia; o antigo mandava mediaUrl/mimetype soltos. */
  media?: { url?: string; mimetype?: string; filename?: string } | null;
  _data?: {
    notifyName?: string;
    pushName?: string;
    // NOWEB/Baileys: em chats @lid o número real vem no key — o nome do campo
    // varia com a versão do Baileys (senderPn, remoteJidAlt, participantPn...).
    key?: {
      senderPn?: string;
      participantPn?: string;
      remoteJidAlt?: string;
      participantAlt?: string;
    } & Record<string, unknown>;
  } & Record<string, unknown>;
}

/**
 * Mídia recebida: as duas formas do WAHA num só lugar. Sem isto o `media_url`
 * ficava null nas versões novas e a foto do cliente virava só o rótulo
 * "Imagem" no chat.
 */
export function mediaUrlOf(p: WahaPayload): string | null {
  return p.media?.url ?? p.mediaUrl ?? null;
}
export function mediaMimeOf(p: WahaPayload): string | null {
  return p.media?.mimetype ?? p.mimetype ?? null;
}
export function mediaNameOf(p: WahaPayload): string | null {
  return p.media?.filename ?? null;
}

export interface WahaEnvelope {
  event?: string;
  session?: string;
  payload?: WahaPayload;
}

export type ChatIdentity =
  | { kind: "phone"; phone: string; lid: null }
  | { kind: "lid"; phone: null; lid: string } // lid = somente dígitos
  | { kind: "group"; phone: null; lid: null };

/**
 * Resolve um chatId WAHA em identidade canônica:
 *  - `{number}@c.us` | `@s.whatsapp.net` -> phone E.164 ("+55...")
 *  - `{lid}@lid` -> lid (somente dígitos; número protegido pelo WhatsApp)
 *  - `@g.us` | formato desconhecido -> group (skip binding CRM)
 */
export function parseChatId(chatId: string): ChatIdentity {
  if (chatId.endsWith("@g.us")) return { kind: "group", phone: null, lid: null };
  if (chatId.endsWith("@lid")) {
    return { kind: "lid", phone: null, lid: chatId.replace(/@.*$/, "") };
  }
  if (chatId.endsWith("@c.us") || chatId.endsWith("@s.whatsapp.net")) {
    const digits = chatId.replace(/@.*$/, "").replace(/^\+/, "");
    return { kind: "phone", phone: "+" + digits, lid: null };
  }
  return { kind: "group", phone: null, lid: null };
}

const STOP_RX = /\b(STOP|PARAR|SAIR|UNSUBSCRIBE)\b/i;

export function verifyHmacSha512(
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

/** Rótulo do preview quando a mensagem não tem texto (só mídia). */
const PREVIEW_BY_TYPE: Record<string, string> = {
  image: "[foto]",
  video: "[vídeo]",
  audio: "[áudio]",
  document: "[documento]",
  sticker: "[figurinha]",
  location: "[localização]",
  contact: "[contato]",
};

function previewFromMessage(p: WahaPayload): string {
  if (p.body) return p.body.slice(0, 280);
  // Antes usava p.type, que o NOWEB não manda (ver messageTypeOf): preview de
  // foto/áudio ficava vazio na lista de conversas.
  const t = messageTypeOf(p);
  return PREVIEW_BY_TYPE[t] ?? (t === "text" ? "" : `[${t}]`);
}

/**
 * Mapeia o `type` cru do WAHA NOWEB para o vocabulário de messages.type do CRM
 * (check constraint messages_type_check). WAHA usa `chat` p/ texto, `ptt` p/
 * áudio de voz, `vcard` p/ contato, etc. Sem esse mapa o INSERT viola a
 * constraint e a mensagem some. O type cru fica em metadata.raw_type.
 */
const WA_TYPE_MAP: Record<string, string> = {
  chat: "text",
  text: "text",
  ptt: "audio",
  audio: "audio",
  image: "image",
  video: "video",
  document: "document",
  sticker: "sticker",
  location: "location",
  vcard: "contact",
  contact: "contact",
  multi_vcard: "contact",
  reaction: "reaction",
};

function mapWahaMessageType(raw: string | undefined): string {
  if (!raw) return "text";
  // Fallback "text": só chegamos ao insert com body/mídia presente (guarda acima),
  // então tratar tipo desconhecido como texto não perde a mensagem.
  return WA_TYPE_MAP[raw.toLowerCase()] ?? "text";
}

/**
 * Tipo final da mensagem. Nesta versão do NOWEB (2026.7) os eventos de mensagem
 * **não trazem `type`** — verificado no payload cru gravado em
 * webhook_events_log. Sem mídia isso cai em "text" e está certo; COM mídia, sem
 * olhar o mime, uma foto entraria como "text" e viraria um balão vazio.
 */
function messageTypeOf(p: WahaPayload): string {
  if (p.type) return mapWahaMessageType(p.type);
  const mime = mediaMimeOf(p);
  if (!mime) return "text";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "document";
}

function notifyNameOf(p: WahaPayload): string | null {
  return p._data?.notifyName ?? p._data?.pushName ?? null;
}

/**
 * Número real do contato quando o chat é @lid (número protegido): o NOWEB
 * entrega o phone-number-jid em `_data.key.senderPn`/`participantPn`
 * (ex.: "5531999999999@s.whatsapp.net"). Retorna E.164 ou null.
 */
function phoneHintOf(p: WahaPayload): string | null {
  const key = p._data?.key;
  if (!key) return null;
  const candidates = [key.senderPn, key.remoteJidAlt, key.participantPn, key.participantAlt];
  for (const raw of candidates) {
    if (!raw || typeof raw !== "string") continue;
    const parsed = parseChatId(raw);
    if (parsed.kind === "phone") return parsed.phone;
  }
  return null;
}

/**
 * Upsert atômico de contato pela identidade canônica. Retorna null se a
 * identidade for de grupo ou a RPC falhar.
 */
async function upsertContact(
  admin: Admin,
  orgId: string,
  parsed: ChatIdentity,
  chatId: string,
  notifyName: string | null,
  /** Número que recebeu a mensagem: vira o dono do contato (visibilidade, 0029). */
  sessionId: string,
  phoneHint: string | null = null,
): Promise<string | null> {
  if (parsed.kind === "group") return null;
  const base = {
    p_org: orgId,
    p_kind: parsed.kind,
    p_phone: parsed.kind === "phone" ? parsed.phone : null,
    p_lid: parsed.kind === "lid" ? parsed.lid : null,
    p_chat_id: chatId,
    p_notify: notifyName,
  };

  // 7 argumentos = assinatura da 0029 (marca o número dono do contato).
  let { data, error } = await admin.rpc("fn_upsert_wa_contact" as never, {
    ...base,
    p_session: sessionId,
  } as never);

  // ⚠️ Banco AINDA sem a 0029: a de 7 args não existe e o PostgREST devolve
  // "Could not find the function". Cai na assinatura antiga (contato nasce sem
  // dono, que é o comportamento de hoje) em vez de derrubar a ingestão — sem
  // isso, deployar antes de aplicar o SQL faria TODA mensagem recebida sumir.
  if (error && /could not find the function/i.test(error.message)) {
    ({ data, error } = await admin.rpc("fn_upsert_wa_contact" as never, base as never));
  }

  if (error) {
    console.error("[waha.ingest] fn_upsert_wa_contact failed", error.message);
    return null;
  }
  const contactId = (data as string) ?? null;

  // Chat @lid esconde o número, mas o payload traz o real em key.senderPn —
  // preenche phone_number se ainda estiver vazio (não sobrescreve edição manual).
  if (contactId && parsed.kind === "lid" && phoneHint) {
    const { error: phoneErr } = await admin
      .from("contacts")
      .update({ phone_number: phoneHint })
      .eq("id", contactId)
      .is("phone_number", null);
    if (phoneErr) console.error("[waha.ingest] phone backfill failed", phoneErr.message);
  }

  return contactId;
}

async function upsertConversation(
  admin: Admin,
  orgId: string,
  contactId: string,
  sessionId: string,
): Promise<string | null> {
  const { data, error } = await admin.rpc(
    "fn_upsert_wa_conversation" as never,
    {
      p_org: orgId,
      p_contact: contactId,
      p_session: sessionId,
    } as never,
  );
  if (error) {
    console.error("[waha.ingest] fn_upsert_wa_conversation failed", error.message);
    return null;
  }
  return (data as string) ?? null;
}

async function markConversation(
  admin: Admin,
  convId: string,
  direction: "inbound" | "outbound",
  preview: string,
  at: string,
): Promise<void> {
  const { error } = await admin.rpc(
    "fn_mark_conversation_message" as never,
    {
      p_conv: convId,
      p_direction: direction,
      p_preview: preview,
      p_at: at,
    } as never,
  );
  if (error) console.error("[waha.ingest] fn_mark_conversation_message failed", error.message);
}

/** Status em que a conversa está fora do dia a dia e some da aba "Mensagens". */
const CLOSED_STATUSES = ["closed", "archived"];

/**
 * Cliente voltou a escrever numa conversa encerrada → reabre (decisão Darlei,
 * 30/07). Sem isso a mensagem entrava e ficava invisível: a aba "Mensagens"
 * esconde closed/archived e ninguém percebia o retorno do cliente. Vale para
 * fechamento manual e para o fechamento automático de "Resolvido"
 * (`lib/attendance/close-on-resolve.ts`), que continua NÃO reabrindo por
 * mudança de etapa — só a fala do cliente reabre.
 *
 * Best-effort: reabrir é efeito colateral, não pode derrubar a ingestão da
 * mensagem. O `in(status)` no WHERE evita corrida com quem fecha ao mesmo tempo
 * (duas mensagens na mesma rajada só geram um reopen).
 */
async function reopenIfClosed(
  admin: Admin,
  orgId: string,
  convId: string,
  prevStatus: string | null,
  ctx: { now: string; requestId: string },
): Promise<void> {
  if (!prevStatus || !CLOSED_STATUSES.includes(prevStatus)) return;

  const { data, error } = await admin
    .from("conversations")
    .update({ status: "open", status_changed_at: ctx.now })
    .eq("id", convId)
    .in("status", CLOSED_STATUSES)
    .select("id")
    .maybeSingle();

  if (error) {
    console.error("[waha.ingest] reabertura da conversa falhou", error.message);
    return;
  }
  if (!data) return; // alguém já reabriu (rajada de mensagens)

  await audit({
    action: "conversation.reopened",
    organizationId: orgId,
    resourceType: "conversation",
    resourceId: convId,
    requestId: ctx.requestId,
    metadata: { reason: "inbound_message", from_status: prevStatus },
  });
}

/**
 * Mensagem recebida (fromMe=false). Contato = remetente (`from`).
 */
async function handleInbound(
  admin: Admin,
  session: Session,
  p: WahaPayload,
  requestId: string,
): Promise<void> {
  const chatId = p.from ?? "";
  const parsed = parseChatId(chatId);
  if (parsed.kind === "group") return; // grupos não fazem binding CRM
  if (!p.id || !chatId) return;
  // WAHA emite eventos vazios p/ status/read-receipt/presence — não viram mensagem.
  if (!p.body && !p.mediaUrl && !p.hasMedia) return;

  const contactId = await upsertContact(
    admin,
    session.organization_id,
    parsed,
    chatId,
    notifyNameOf(p),
    session.id,
    phoneHintOf(p),
  );
  if (!contactId) return;
  const conversationId = await upsertConversation(
    admin,
    session.organization_id,
    contactId,
    session.id,
  );
  if (!conversationId) return;

  const now = new Date().toISOString();
  const { data: insertedMessage, error: insertErr } = await admin
    .from("messages")
    .insert({
      organization_id: session.organization_id,
      conversation_id: conversationId,
      channel_session_id: session.id,
      contact_id: contactId,
      external_id: p.id,
      type: messageTypeOf(p),
      direction: "inbound",
      status: "delivered",
      ack: p.ack ?? null,
      body: p.body ?? null,
      media_url: mediaUrlOf(p),
      media_mime: mediaMimeOf(p),
      sent_via: "external_device",
      sent_at: p.timestamp ? new Date(p.timestamp * 1000).toISOString() : now,
      delivered_at: now,
      metadata: {
        raw_type: p.type,
        ack_name: p.ackName,
        // Chats @lid: guarda o key cru pra diagnosticar de onde vem o número
        // real nesta versão do Baileys/WAHA (senderPn vs remoteJidAlt etc.).
        ...(parsed.kind === "lid" && p._data?.key ? { wa_key: p._data.key } : {}),
      },
    })
    .select("id")
    .maybeSingle();

  // Idempotência: 23505 = unique (organization_id, external_id) já ingerido.
  if (insertErr && insertErr.code !== "23505") {
    console.error("[waha.ingest] message insert failed", insertErr.message);
    return;
  }
  if (insertErr?.code === "23505") return;

  // Estado ANTES de marcar — última entrada alimenta o limitador do push (abaixo)
  // e o status decide se a conversa precisa reabrir.
  const { data: convBefore } = await admin
    .from("conversations")
    .select("last_inbound_at, status")
    .eq("id", conversationId)
    .maybeSingle();
  const convPrev = convBefore as { last_inbound_at: string | null; status: string | null } | null;
  const prevInboundAt = convPrev?.last_inbound_at ?? null;

  await markConversation(admin, conversationId, "inbound", previewFromMessage(p), now);

  await reopenIfClosed(admin, session.organization_id, conversationId, convPrev?.status ?? null, {
    now,
    requestId,
  });

  if (p.body && STOP_RX.test(p.body)) {
    await admin
      .from("contacts")
      .update({ is_blocked: true, blocked_reason: "stop_keyword", blocked_at: now })
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

  // Aviso de "mensagem nova de cliente" (push nativo) — tenant de atendente único
  // (pós-venda). Limitador: só notifica quando a conversa ficou 3+ min sem entrada
  // do cliente (uma chegada nova), pra não tocar a cada mensagem de uma rajada.
  if (hasPosvendaModule(session.organization_id)) {
    const THROTTLE_MS = 3 * 60 * 1000;
    const gap = prevInboundAt
      ? Date.parse(now) - Date.parse(prevInboundAt)
      : Number.POSITIVE_INFINITY;
    if (gap >= THROTTLE_MS) {
      const who = notifyNameOf(p) || "Cliente";
      const preview = (previewFromMessage(p) || "Nova mensagem").slice(0, 140);
      after(async () => {
        await sendPushToOrg(admin, session.organization_id, {
          title: `Nova mensagem — ${who}`,
          body: preview,
          url: "/app/inbox",
          tag: `conv-${conversationId}`,
        });
      });
    }
  }

  // Enfileira o dispatch e drena o dispatcher na sequência via after() — roda
  // depois do 200 pro WAHA, então não atrasa o webhook. Sem isso a resposta do
  // bot espera o próximo tick do cron (minutos). O cron continua como rede de
  // segurança: se o drain inline falhar, o evento fica `pending` e o próximo
  // tick agendado o processa.
  if (insertedMessage?.id) {
    const inboundMessageId = insertedMessage.id;
    after(async () => {
      const { error } = await admin.rpc(
        "emit_event" as never,
        {
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
        } as never,
      );
      if (error) {
        console.error("[waha.ingest] emit dispatch_requested failed", error.message);
        return;
      }
      try {
        await dispatchAgents();
      } catch (err) {
        console.error(
          "[waha.ingest] inline agent dispatch failed",
          err instanceof Error ? err.message : String(err),
        );
      }
    });
  }
}

/**
 * fromMe=true: alguém respondeu direto do WhatsApp no celular (não pelo
 * composer). Registrado como outbound p/ o histórico do CRM ficar completo.
 *
 * 🐛 04/08/2026 — TODA mensagem enviada pelo celular era descartada em silêncio.
 * O código lia o chat de `p.to`, mas o **NOWEB não manda `to`** nos eventos
 * fromMe: o chat vem em `p.from` (provado no payload cru de webhook_events_log:
 * `from: "12154774274171@lid", to: undefined, source: "app"`). Com `to`
 * undefined, `chatId` virava "" e a guarda abaixo abortava. Sintoma: 37 eventos
 * fromMe recebidos, ZERO linha em messages.
 *
 * A precedência `to ?? from` cobre os dois formatos: engine que manda `to`
 * (WEBJS) continua usando o destinatário; NOWEB cai no `from`, que nele é o
 * chat do cliente — nunca o número do operador.
 *
 * Não duplica o que foi enviado PELO CRM: aquele caminho grava o id do WAHA em
 * `external_id`, então o mesmo evento aqui bate na unique (org, external_id) e
 * sai pelo 23505 logo abaixo.
 *
 * ⚠️ NÃO passe `phoneHintOf(p)` aqui (o inbound passa). Em evento fromMe o
 * `_data.key.senderPn` é o **nosso** número, então o hint gravaria o número da
 * empresa no cadastro do cliente.
 */
async function handleOutboundFromUserPhone(
  admin: Admin,
  session: Session,
  p: WahaPayload,
  requestId: string,
): Promise<void> {
  const chatId = p.to ?? p.from ?? "";
  const parsed = parseChatId(chatId);
  if (parsed.kind === "group") return;
  if (!p.id || !chatId) return;
  // "Chat consigo mesmo": mensagem que a pessoa manda pro próprio número da
  // empresa (teste, recado pessoal). Sem esta guarda o CRM criaria um contato e
  // uma conversa da Itaville com a Itaville.
  if (parsed.kind === "phone" && session.phone_number) {
    const so = (s: string) => s.replace(/\D/g, "");
    if (so(parsed.phone) === so(session.phone_number)) return;
  }
  if (!p.body && !p.mediaUrl && !p.hasMedia) return;

  const contactId = await upsertContact(
    admin,
    session.organization_id,
    parsed,
    chatId,
    notifyNameOf(p),
    session.id,
  );
  if (!contactId) return;
  const conversationId = await upsertConversation(
    admin,
    session.organization_id,
    contactId,
    session.id,
  );
  if (!conversationId) return;

  const now = new Date().toISOString();
  const { error: insertErr } = await admin.from("messages").insert({
    organization_id: session.organization_id,
    conversation_id: conversationId,
    channel_session_id: session.id,
    contact_id: contactId,
    external_id: p.id,
    type: messageTypeOf(p),
    direction: "outbound",
    status: "sent",
    ack: p.ack ?? null,
    body: p.body ?? null,
    media_url: mediaUrlOf(p),
    media_mime: mediaMimeOf(p),
    sent_via: "external_device",
    sent_at: p.timestamp ? new Date(p.timestamp * 1000).toISOString() : now,
    metadata: {
      raw_type: p.type,
      fromMe: true,
      ...(mediaNameOf(p) ? { filename: mediaNameOf(p) } : {}),
    },
  });
  if (insertErr && insertErr.code !== "23505") {
    console.error("[waha.ingest] outbound insert failed", insertErr.message);
    return;
  }
  if (insertErr?.code === "23505") return;

  await markConversation(admin, conversationId, "outbound", previewFromMessage(p), now);

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

async function handleAck(admin: Admin, session: Session, p: WahaPayload): Promise<void> {
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

interface SessionStatusRow extends Session {
  is_warmup_complete: boolean | null;
  warmup_started_at: string | null;
}

async function handleSessionStatus(
  admin: Admin,
  session: SessionStatusRow,
  p: WahaPayload,
): Promise<void> {
  const status = (p.status ?? "").toUpperCase() || null;
  if (!status) return;
  const allowed = new Set(["STARTING", "SCAN_QR_CODE", "WORKING", "STOPPED", "FAILED"]);
  if (!allowed.has(status)) return;
  const now = new Date().toISOString();

  const update: Record<string, unknown> = { status, last_status_change_at: now };
  if (status === "WORKING" && session.warmup_started_at && !session.is_warmup_complete) {
    update.is_warmup_complete = true;
    update.warmup_completed_at = now;
  }
  await admin.from("channel_sessions").update(update).eq("id", session.id);
}

/**
 * Roteador único de eventos WAHA. Os dois route handlers convergem aqui após
 * resolver a sessão e validar HMAC.
 */
export async function dispatchWahaEvent(
  admin: Admin,
  session: SessionStatusRow,
  envelope: WahaEnvelope,
  requestId: string,
): Promise<void> {
  const eventType = envelope.event ?? "unknown";
  const payload = envelope.payload ?? {};

  if (eventType === "message" || eventType === "message.any") {
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
}
