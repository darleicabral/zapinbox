/**
 * GET /api/v1/ai/providers — lista os 3 provedores LLM suportados.
 * Estático; serve apenas para a UI montar o select de credentials.
 */
import { randomUUID } from "node:crypto";

import { ok, fail } from "@/lib/api/wrappers";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

const PROVIDERS = [
  {
    id: "anthropic",
    display_name: "Anthropic",
    docs_url: "https://docs.anthropic.com/en/api/getting-started",
    key_prefix_hint: "sk-ant-",
  },
  {
    id: "openai",
    display_name: "OpenAI",
    docs_url: "https://platform.openai.com/docs/quickstart",
    key_prefix_hint: "sk-",
  },
  {
    id: "google",
    display_name: "Google (Gemini)",
    docs_url: "https://ai.google.dev/gemini-api/docs/api-key",
    key_prefix_hint: "AIza",
  },
  {
    id: "opencode",
    display_name: "OpenCode Zen",
    docs_url: "https://opencode.ai/docs/zen/",
    key_prefix_hint: "sk-",
  },
];

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authUser = await loadAuthUser();
  if (!authUser) return fail("unauthenticated", "Auth required.", 401, { requestId });
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) {
    return fail("forbidden_tenant", "Sem organização ativa.", 403, { requestId });
  }
  return ok({ providers: PROVIDERS }, { requestId });
}
