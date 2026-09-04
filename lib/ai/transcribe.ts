/**
 * lib/ai/transcribe.ts — entende a mídia que o lead manda no WhatsApp:
 * transcreve áudio e descreve imagem.
 *
 * Por que na CHEGADA e não sob demanda: o arquivo do WAHA é EFÊMERO. Ele mora
 * em `/tmp/whatsapp-files` dentro do container e some — áudio de duas horas
 * atrás já devolvia `ENOENT: no such file or directory` (medido em 03/09/2026).
 * Se não acontecer no webhook, não acontece nunca.
 *
 * O que isto conserta: mídia virava SILÊNCIO. A mensagem entrava sem `body`, o
 * run do agente morria em `inbound_missing` ("no inbound body to process") e o
 * lead não recebia nada. Em 03/09 foram 9 áudios e 1 imagem; em 04/09, mais uma
 * imagem às 07h31.
 *
 * Toda falha aqui devolve null de propósito: o piso é o comportamento antigo
 * (silêncio), nunca uma exceção estourando no webhook.
 */
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { getWahaClient } from "@/lib/waha/client";

/** O 1º é mais barato; o 2º é o clássico, fica como rede. Os dois falam pt-BR. */
const MODELOS_AUDIO = ["gpt-4o-mini-transcribe", "whisper-1"] as const;
/** Visão: o mini resolve print de anúncio; o grande fica como rede. */
const MODELOS_VISAO = ["gpt-4o-mini", "gpt-4o"] as const;
/** Limite da API é 25 MB. Mídia de zap não passa de poucos MB; o teto é sanidade. */
const LIMITE_BYTES = 20 * 1024 * 1024;
const TIMEOUT_MS = 25_000;
/**
 * Dica de vocabulário passada pra API. Transcrição erra justamente em nome
 * próprio e jargão: "geminada" virava "germinada", "FGTS" virava "efe ge tê
 * esse". O campo `prompt` enviesa o decoder pro domínio, e em imóvel é onde
 * mais dói (bairro e valor errados mandam o corretor pro lugar errado).
 */
const VOCABULARIO =
  "Imobiliaria em Belo Horizonte e regiao. Termos comuns: casa geminada, " +
  "apartamento, kitnet, lote, terreno, fazendinha, hectares, condominio, " +
  "financiamento, entrada, parcela, FGTS, escritura, IPTU, documentacao, " +
  "visita, corretor, planta, pronto para morar.";
/**
 * O que pedir pra visão. O caso que mais aparece é PRINT DE ANÚNCIO: o lead
 * tira foto da tela e manda. Ler os dados visíveis (bairro, preço, quartos,
 * referência) é o que permite o agente achar o imóvel no catálogo depois.
 */
const INSTRUCAO_IMAGEM =
  "Descreva esta imagem que um cliente mandou para uma imobiliária, em no máximo " +
  "3 frases, em português do Brasil. Se for print de anúncio, site ou conversa, " +
  "transcreva os dados visíveis que importam: tipo de imóvel, bairro, cidade, " +
  "preço, quartos, área e código de referência. Se for foto de imóvel, descreva " +
  "o que se vê. Se for documento, diga qual documento é. Não invente nada que " +
  "não esteja visível, não suponha e não cumprimente: só descreva.";

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

/**
 * Baixa a mídia do WAHA com as guardas. Compartilhado por áudio e imagem.
 *
 * A guarda de origem é a mesma da rota de mídia: a URL vem de webhook já
 * verificado por HMAC, mas provar a origem fecha a porta pra qualquer coisa que
 * force o servidor a buscar outro endereço.
 */
async function baixarMidia(mediaUrl: string | null, rotulo: string): Promise<ArrayBuffer | null> {
  if (!mediaUrl) return null;
  const waha = getWahaClient();
  if (!waha) return null;
  if (!mediaUrl.startsWith(waha.origin)) {
    logger.warn("[" + rotulo + "] url de mídia fora do WAHA", { url: mediaUrl });
    return null;
  }
  let dados: ArrayBuffer;
  try {
    const res = await waha.fetchMedia(mediaUrl);
    if (!res.ok) {
      // 404 aqui = o WAHA já limpou o /tmp. Não tem retentativa possível.
      logger.warn("[" + rotulo + "] download falhou", { status: res.status });
      return null;
    }
    dados = await res.arrayBuffer();
  } catch (err) {
    logger.warn("[" + rotulo + "] download deu erro", {
      erro: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  if (!dados.byteLength || dados.byteLength > LIMITE_BYTES) {
    logger.warn("[" + rotulo + "] tamanho fora do aceitável", { bytes: dados.byteLength });
    return null;
  }
  return dados;
}

function chaveOpenAI(rotulo: string): string | null {
  const chave = env.OPENAI_API_KEY;
  if (!chave) {
    logger.warn("[" + rotulo + "] OPENAI_API_KEY ausente — mídia segue sem interpretação");
    return null;
  }
  return chave;
}

export async function transcreverAudio(args: {
  mediaUrl: string | null;
  mimeType: string | null;
}): Promise<Transcricao | null> {
  const chave = chaveOpenAI("transcribe");
  if (!chave) return null;
  const dados = await baixarMidia(args.mediaUrl, "transcribe");
  if (!dados) return null;

  const tipo = (args.mimeType ?? "audio/ogg").split(";")[0]?.trim() || "audio/ogg";
  for (const modelo of MODELOS_AUDIO) {
    try {
      const form = new FormData();
      form.append("file", new Blob([dados], { type: tipo }), nomeArquivo(args.mimeType));
      form.append("model", modelo);
      form.append("language", "pt");
      form.append("prompt", VOCABULARIO);
      const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: "Bearer " + chave },
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

/**
 * Descreve a imagem recebida, pra ela deixar de ser silêncio.
 *
 * Diferente do áudio, isto NÃO é o que o cliente disse: é a NOSSA leitura da
 * imagem. Quem grava marca com `described_from`, e o runtime avisa o modelo, pra
 * ele não tratar a descrição como fala do cliente.
 */
export async function descreverImagem(args: {
  mediaUrl: string | null;
  mimeType: string | null;
}): Promise<Transcricao | null> {
  const chave = chaveOpenAI("vision");
  if (!chave) return null;
  const dados = await baixarMidia(args.mediaUrl, "vision");
  if (!dados) return null;

  const tipo = (args.mimeType ?? "image/jpeg").split(";")[0]?.trim() || "image/jpeg";
  const base64 = Buffer.from(new Uint8Array(dados)).toString("base64");
  for (const modelo of MODELOS_VISAO) {
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer " + chave, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: modelo,
          max_tokens: 300,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: INSTRUCAO_IMAGEM },
                {
                  // `high` de propósito: print de anúncio tem preço em fonte
                  // pequena, e é justamente o dado que precisa sair certo.
                  type: "image_url",
                  image_url: { url: "data:" + tipo + ";base64," + base64, detail: "high" },
                },
              ],
            },
          ],
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        logger.warn("[vision] api recusou", { modelo, status: res.status });
        continue;
      }
      const json = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const texto = (json.choices?.[0]?.message?.content ?? "").trim();
      if (texto) return { texto, modelo };
      logger.warn("[vision] api devolveu texto vazio", { modelo });
    } catch (err) {
      logger.warn("[vision] chamada falhou", {
        modelo,
        erro: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return null;
}
