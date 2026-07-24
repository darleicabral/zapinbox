/**
 * Web Push (VAPID) — envio de notificação nativa pro PWA do usuário.
 *
 * Degrada pra noop quando as chaves VAPID não estão configuradas (o WhatsApp
 * segue como canal principal de aviso). Fire-and-forget: falha aqui nunca
 * derruba o fluxo chamador. Assinaturas mortas (404/410 do push service) são
 * removidas na hora.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import webpush from "web-push";

import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

export interface PushPayload {
  title: string;
  body: string;
  /** Rota aberta ao tocar na notificação (ex.: /app/inbox/<id>). */
  url?: string;
  tag?: string;
}

let configured: boolean | null = null;

function ensureConfigured(): boolean {
  if (configured !== null) return configured;
  if (!env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    configured = false;
    return false;
  }
  webpush.setVapidDetails(
    env.VAPID_SUBJECT || "mailto:suporte@zapinbox.com.br",
    env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
    env.VAPID_PRIVATE_KEY,
  );
  configured = true;
  return true;
}

interface SubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * Envia para TODOS os usuários da org que tenham algum aparelho assinado.
 * Útil em tenant de atendente único (não há "dono" específico a notificar).
 * Retorna o total de envios ok.
 */
export async function sendPushToOrg(
  admin: SupabaseClient,
  organizationId: string,
  payload: PushPayload,
): Promise<number> {
  if (!ensureConfigured()) return 0;
  const { data, error } = await admin
    .from("push_subscriptions")
    .select("user_id")
    .eq("organization_id", organizationId);
  if (error || !data?.length) return 0;
  const userIds = [...new Set((data as { user_id: string }[]).map((r) => r.user_id))];
  let total = 0;
  for (const uid of userIds) {
    total += await sendPushToUser(admin, organizationId, uid, payload);
  }
  return total;
}

/** Envia para TODOS os aparelhos assinados do usuário na org. Retorna nº de envios ok. */
export async function sendPushToUser(
  admin: SupabaseClient,
  organizationId: string,
  userId: string,
  payload: PushPayload,
): Promise<number> {
  if (!ensureConfigured()) return 0;

  const { data, error } = await admin
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .eq("organization_id", organizationId)
    .eq("user_id", userId);
  if (error || !data?.length) return 0;

  const body = JSON.stringify(payload);
  let sent = 0;

  await Promise.all(
    (data as SubscriptionRow[]).map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          body,
          { TTL: 3600, urgency: "high" },
        );
        sent += 1;
        await admin
          .from("push_subscriptions")
          .update({ last_used_at: new Date().toISOString() })
          .eq("id", sub.id);
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          // Assinatura morta (app desinstalado/permissão revogada) — remove.
          await admin.from("push_subscriptions").delete().eq("id", sub.id);
        } else {
          logger.warn("[push] envio falhou (ignorado)", {
            user_id: userId,
            status: status ?? null,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }),
  );

  return sent;
}
