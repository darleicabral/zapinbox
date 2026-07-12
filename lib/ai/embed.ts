/**
 * Embedding wrapper for the RAG pipeline.
 *
 * Routes through Vercel AI Gateway when `AI_GATEWAY_API_KEY` is set; otherwise
 * uses the OpenAI provider directly (still no `@anthropic-ai/sdk`-style imports
 * — embeddings are an OpenAI capability and the gateway proxies them).
 */

import { embed } from "ai";

import {
  DEFAULT_EMBEDDING_MODEL,
  gatewayConfig,
  gatewayHeaders,
  isEmbeddingProviderConfigured,
  resolveEmbeddingModel,
  type ModelId,
} from "@/lib/ai/gateway";

export interface EmbedOptions {
  organizationId: string;
  model?: ModelId;
}

export interface EmbedResult {
  embedding: number[];
  promptTokens: number;
  model: string;
}

export async function embedText(
  content: string,
  opts: EmbedOptions,
): Promise<EmbedResult> {
  if (!isEmbeddingProviderConfigured()) {
    throw new Error("embed_unavailable: no AI_GATEWAY_API_KEY or OPENAI_API_KEY configured");
  }
  const model = opts.model ?? DEFAULT_EMBEDDING_MODEL;
  const cfg = gatewayConfig();

  // When using the gateway, model string `openai/text-embedding-3-small` is
  // routed automatically (SDK reads AI_GATEWAY_API_KEY from process.env).
  // Without the gateway, resolveEmbeddingModel builds the direct OpenAI
  // provider — a plain string would fail with "Unauthenticated".
  const result = await embed({
    model: resolveEmbeddingModel(model),
    value: content,
    headers: cfg ? gatewayHeaders({ organizationId: opts.organizationId }) : undefined,
  });

  // EmbedResult.embedding is `number[]` for single-value embed.
  const promptTokens =
    (result.usage as { tokens?: number; promptTokens?: number } | undefined)?.tokens ??
    (result.usage as { tokens?: number; promptTokens?: number } | undefined)?.promptTokens ??
    0;

  return {
    embedding: result.embedding,
    promptTokens,
    model: typeof model === "string" ? model : String(model),
  };
}
