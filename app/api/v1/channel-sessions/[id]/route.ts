/**
 * GET /api/v1/channel-sessions/[id] — health check AO VIVO de um canal.
 *
 * Consulta o status real no WAHA, grava `last_health_check_at` (+ sincroniza
 * `status`) no DB e devolve o estado atual. É a fonte de verdade quando o
 * usuário abre a Central de Conexões ou está aguardando o QR ser escaneado.
 *
 * Qualquer membro da org pode consultar. organization_id vem da sessão.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { isChannelStatus } from "@/lib/schemas/channels";
import { createClient } from "@/lib/supabase/server";
import { getWahaClient } from "@/lib/waha/client";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await params;

  const user = await loadAuthUser();
  if (!user) return fail("unauthenticated", "Auth required.", 401, { requestId });
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) return fail("forbidden_tenant", "Nenhuma organização ativa.", 403, { requestId });

  const supabase = await createClient();
  const { data: session } = await supabase
    .from("channel_sessions")
    .select("id, waha_session_name, display_name, phone_number, status")
    .eq("organization_id", activeOrg.orgId)
    .eq("id", id)
    .maybeSingle();
  if (!session) return fail("not_found", "Canal não encontrado.", 404, { requestId });

  const waha = getWahaClient();
  if (!waha) {
    // Sem WAHA ativo: devolve o que está no DB, sinalizando que não deu p/ checar ao vivo.
    return ok({ ...session, waha_configured: false }, { requestId });
  }

  let liveStatus = session.status as string;
  let phoneNumber = session.phone_number as string | null;
  try {
    const remote = (await waha.getSessionQr(session.waha_session_name)) as {
      status?: string;
      me?: { id?: string; pushName?: string };
    };
    if (remote.status) liveStatus = remote.status;
    // WAHA expõe o número (JID `<phone>@c.us`) quando a sessão está WORKING.
    const jid = remote.me?.id;
    if (jid && !phoneNumber) phoneNumber = jid.replace(/@.*/, "");
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    // 404 no WAHA = sessão não iniciada lá → considera STOPPED.
    if (msg.includes("404")) liveStatus = "STOPPED";
    // outros erros: mantém o status do DB (não sobrescreve com ruído transitório).
  }

  // Sincroniza o DB: sempre carimba o health check; atualiza status/telefone só se válido.
  const patch: Record<string, unknown> = { last_health_check_at: new Date().toISOString() };
  if (isChannelStatus(liveStatus) && liveStatus !== session.status) {
    patch.status = liveStatus;
    patch.last_status_change_at = new Date().toISOString();
  }
  if (phoneNumber && phoneNumber !== session.phone_number) patch.phone_number = phoneNumber;
  await supabase
    .from("channel_sessions")
    .update(patch)
    .eq("organization_id", activeOrg.orgId)
    .eq("id", id);

  return ok(
    {
      id: session.id,
      waha_session_name: session.waha_session_name,
      display_name: session.display_name,
      phone_number: phoneNumber,
      status: liveStatus,
      last_health_check_at: patch.last_health_check_at,
      waha_configured: true,
    },
    { requestId },
  );
}
