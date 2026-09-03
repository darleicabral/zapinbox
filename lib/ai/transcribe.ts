/**
 * lib/ai/transcribe.ts — transcreve o áudio que o lead manda no WhatsApp.
 *
 * Por que na CHEGADA e não sob demanda: o arquivo do WAHA é EFÊMERO. Ele mora
 * em `/tmp/whatsapp-files` dentro do container e some — áudio de duas horas
 * atrás já devolvia `ENOENT: no such file or directory` (medido em 03/09/2026).
 * Se a transcrição não acontecer no webhook, não acontece nunca.
 *
 * O que isto conserta: áudio virava SILÊNCIO. A mensagem entrava sem `body`, o
 * run do agente morria em `inbound_missing` ("no inbound body to process") e o
 * lead não recebia nada. Só em 03/09 foram 9 áudios assim.
 */
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { getWahaClient } from "@/lib/waha/client";

/** O 1º é mais barato; o 2º é o clássico, fica como rede. Os dois falam pt-BR. */
const MODELOS = ["gpt-4o-mini-transcribe", "whisper-1"] as const;
/** Limite da API é 25 MB. Áudio de zap não passa de 1 MB; o teto é só sanidade. */
const LIMITE_BYTES = 20 * 1024 * 1024;
const TIMEOUT_MS = 25_000;
/**
 * Dica de vocabulario passada pra API. Transcricao erra justamente em nome
 * proprio e jargao: "geminada" virava "germinada", "FGTS" virava "efe ge te
 * esse". O campo `prompt` enviesa o decoder pro dominio, e imovel e onde mais
 * doi (bairro e valor errados mandam o corretor pro lugar errado).
 */
const VOCABULARIO =
  "Imobiliaria em Belo Horizonte e regiao. Termos comuns: casa geminada, " +
  "apartamento, kitnet, lote, terreno, fazendinha, hectares, condominio, " +
  "financiamento, entrada, parcela, FGTS, escritura, IPTU, documentacao, " +
  "visita, corretor, planta, pronto para morar.";

export interface Transcricao {
  texto: string;
  modelo: string;
}

/** Extensão que a API reconhece. Voz de WhatsApp é sempre ogg/opus. */
function nomeArquivo(mime: string | null): string {
  const m = (mime ?? "").toLowerCase();
  if (m.includes("mpeg") || m.includes("mp3")) return "audio.mp3";
  if (m.includes("mp4") || m.includes("m4a") || m.includes("aac")) return "audio.m4a";
  if (m.includes("wav")) return "audio.wav";
  return "audio.ogg";
}

export async function transcreverAudio(args: {
  mediaUrl: string | null;
  mimeType: string | null;
}): Promise<Transcricao | null> {
  const chave = env.OPENAI_API_KEY;
  if (!chave) {
    logger.warn("[transcribe] OPENAI_API_KEY ausente — áudio segue sem transcrição");
    return null;
  }
  if (!args.mediaUrl) return null;
  const waha = getWahaClient();
  if (!waha) return null;
  // Mesma guarda da rota de mídia: a URL vem de webhook já verificado por HMAC,
  // mas provar a origem fecha a porta pra qualquer coisa que force o servidor a
  // buscar outro endereço.
  if (!args.mediaUrl.startsWith(waha.origin)) {
    logger.warn("[transcribe] url de mídia fora do WAHA", { url: args.mediaUrl });
    return null;
  }

  let dados: ArrayBuffer;
  try {
    const res = await waha.fetchMedia(args.mediaUrl);
    if (!res.ok) {
      // 404 aqui = o WAHA já limpou o /tmp. Não tem retentativa possível.
      logger.warn("[transcribe] download falhou", { status: res.status });
      return null;
    }
    dados = await res.arrayBuffer();
  } catch (err) {
    logger.warn("[transcribe] download deu erro", {
      erro: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  if (!dados.byteLength || dados.byteLength > LIMITE_BYTES) {
    logger.warn("[transcribe] tamanho fora do aceitável", { bytes: dados.byteLength });
    return null;
  }

  const tipo = (args.mimeType ?? "audio/ogg").split(";")[0]?.trim() || "audio/ogg";
  for (const modelo of MODELOS) {
    try {
      const form = new FormData();
      form.append("file", new Blob([dados], { type: tipo }), nomeArquivo(args.mimeType));
      form.append("model", modelo);
      form.append("language", "pt");
      form.append("prompt", VOCABULARIO);
      const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${chave}` },
        body: form,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        logger.warn("[transcribe] api recusou", { modelo, status: res.status });
        continue;
      }
      const json = (await res.json()) as { text?: string };
      const texto = (json.text ?? "").trim();
      if (texto) return { texto, modelo };
      logger.warn("[transcribe] api devolveu texto vazio", { modelo });
    } catch (err) {
      logger.warn("[transcribe] chamada falhou", {
        modelo,
        erro: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return null;
}
