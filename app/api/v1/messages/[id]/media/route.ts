/**
 * GET /api/v1/messages/[id]/media — serve a mídia RECEBIDA de uma mensagem.
 *
 * Não guardamos cópia (decisão Darlei 26/07): o arquivo vive no WAHA e esta
 * rota faz a ponte. Ela existe porque (a) o WAHA exige a API key, que não pode
 * ir pro browser, e (b) a URL dele é http interno — o navegador bloquearia o
 * conteúdo misto.
 *
 * Client de SESSÃO (RLS): só quem é da org enxerga a mensagem.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { createClient } from "@/lib/supabase/server";
import { getWahaClient } from "@/lib/waha/client";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  const supabase = await createClient();

  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) return fail("unauthenticated", "Auth required.", 401, { requestId });

  const { data: message, error } = await supabase
    .from("messages")
    .select("id, media_url, media_mime, type, metadata")
    .eq("id", id)
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!message) return fail("not_found", "Mensagem não encontrada.", 404, { requestId });

  const m = message as {
    media_url: string | null;
    media_mime: string | null;
    type: string;
    metadata: Record<string, unknown> | null;
  };
  if (!m.media_url) {
    return fail("no_media", "Esta mensagem não tem mídia guardada.", 404, { requestId });
  }

  const waha = getWahaClient();
  if (!waha) {
    return fail("waha_not_configured", "WhatsApp não configurado.", 503, { requestId });
  }
  // A URL vem do webhook (já verificado por HMAC), mas conferir a origem fecha
  // a porta pra qualquer coisa que force o servidor a buscar outro endereço.
  if (!m.media_url.startsWith(waha.origin)) {
    return fail("invalid_media_url", "Mídia fora do servidor de WhatsApp.", 422, { requestId });
  }

  let upstream: Response;
  try {
    upstream = await waha.fetchMedia(m.media_url);
  } catch {
    return fail("waha_unreachable", "Não consegui baixar a mídia do WhatsApp.", 502, { requestId });
  }
  if (!upstream.ok || !upstream.body) {
    return fail("media_unavailable", "A mídia não está mais disponível.", 404, { requestId });
  }

  const filename =
    (typeof m.metadata?.filename === "string" && m.metadata.filename) || `midia-${id.slice(0, 8)}`;
  const contentType =
    m.media_mime ?? upstream.headers.get("content-type") ?? "application/octet-stream";
  // Documento baixa; imagem/áudio/vídeo tocam na própria conversa.
  const inline = /^(image|audio|video)\//.test(contentType);

  return new Response(upstream.body, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${filename.replace(/"/g, "")}"`,
      "Cache-Control": "private, max-age=3600",
    },
  });
}
