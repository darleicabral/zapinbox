/**
 * Vercel AI Gateway wrapper.
 *
 * Centralises model routing so the rest of the codebase only references model
 * strings like `"anthropic/claude-sonnet-4-6"`. Lazy initialisation: if
 * `AI_GATEWAY_API_KEY` (or `ANTHROPIC_API_KEY` as fallback) is missing we
 * deliberately do NOT throw at import time — `isAiGatewayConfigured()` lets
 * callers skip gracefully.
 *
 * Anti-pattern guard (CLAUDE.md): we never `import Anthropic from "@anthropic-ai/sdk"`.
 * Only model strings via the gateway-shaped `ai` SDK calls.
 */

import { env } from "@/lib/env";

export type ModelId =
  | "anthropic/claude-sonnet-4-6"
  | "anthropic/claude-haiku-4-5"
  | "openai/text-embedding-3-small"
  // Allow arbitrary tenant-configured strings without losing autocomplete on the canonical ones.
  | (string & {});

export const DEFAULT_BOT_MODEL: ModelId = "anthropic/claude-sonnet-4-6";
export const DEFAULT_CLASSIFIER_MODEL: ModelId = "anthropic/claude-haiku-4-5";
export const DEFAULT_EMBEDDING_MODEL: ModelId = "openai/text-embedding-3-small";

export function isAiGatewayConfigured(): boolean {
  return Boolean(env.AI_GATEWAY_API_KEY) || Boolean(env.ANTHROPIC_API_KEY);
}

export function isEmbeddingProviderConfigured(): boolean {
  // Embeddings go through the gateway when `AI_GATEWAY_API_KEY` is set;
  // otherwise the worker calls `openai/...` directly via OPENAI_API_KEY.
  return Boolean(env.AI_GATEWAY_API_KEY) || Boolean(env.OPENAI_API_KEY);
}

/**
 * Headers that flow with every gateway call. Tenant ID lets the gateway
 * dashboard slice usage per organization; ZDR opts the request out of provider
 * training corpora (privacy-by-default for tenant data).
 */
export function gatewayHeaders(opts: { organizationId: string }): Record<string, string> {
  return {
    "X-AI-Gateway-Tenant-Id": opts.organizationId,
    "X-AI-Gateway-Zero-Retention": "1",
  };
}

/**
 * The `ai` SDK uses `AI_GATEWAY_API_KEY` from process.env automatically when
 * passing string model ids. We surface it here so the worker can fail fast
 * with a clear skip reason, and so future explicit `createGateway()` callers
 * have the canonical place to read config.
 */
export function gatewayConfig(): { apiKey: string; baseURL?: string } | null {
  if (!env.AI_GATEWAY_API_KEY) return null;
  return {
    apiKey: env.AI_GATEWAY_API_KEY,
    baseURL: env.AI_GATEWAY_BASE_URL || undefined,
  };
}

/**
 * Resolves a `provider/model` string to something `generateText`/`embed` can
 * consume. With `AI_GATEWAY_API_KEY` set, the plain string routes through the
 * Vercel AI Gateway (SDK reads the key from process.env). WITHOUT it, a plain
 * string fails with "Unauthenticated. Configure AI_GATEWAY_API_KEY or use a
 * provider module." — so we build the direct provider module from the
 * per-provider API key, same pattern as lib/ai/runtime/agent.ts#buildModel.
 */
export function resolveLanguageModel(modelId: ModelId): Parameters<typeof import("ai").generateText>[0]["model"] {
  if (env.AI_GATEWAY_API_KEY) return modelId;
  const [provider, ...rest] = String(modelId).split("/");
  const bareModel = rest.join("/");
  if (provider === "anthropic" && env.ANTHROPIC_API_KEY && bareModel) {
    // Lazy require keeps the provider module out of edge bundles that only
    // need the string path.
    const { createAnthropic } = require("@ai-sdk/anthropic") as typeof import("@ai-sdk/anthropic");
    return createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })(bareModel);
  }
  if (provider === "openai" && env.OPENAI_API_KEY && bareModel) {
    const { createOpenAI } = require("@ai-sdk/openai") as typeof import("@ai-sdk/openai");
    return createOpenAI({ apiKey: env.OPENAI_API_KEY })(bareModel);
  }
  // No key for the provider — return the string; the call will fail with the
  // SDK's own clear error, and callers already gate on isAiGatewayConfigured.
  return modelId;
}

/** Embedding counterpart of resolveLanguageModel (OpenAI-only capability). */
export function resolveEmbeddingModel(modelId: ModelId): Parameters<typeof import("ai").embed>[0]["model"] {
  if (env.AI_GATEWAY_API_KEY) return modelId;
  const [provider, ...rest] = String(modelId).split("/");
  const bareModel = rest.join("/");
  if (provider === "openai" && env.OPENAI_API_KEY && bareModel) {
    const { createOpenAI } = require("@ai-sdk/openai") as typeof import("@ai-sdk/openai");
    return createOpenAI({ apiKey: env.OPENAI_API_KEY }).textEmbeddingModel(bareModel);
  }
  return modelId;
}
