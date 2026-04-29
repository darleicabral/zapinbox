/**
 * Validação de env vars com Zod.
 *
 * Chamada implicitamente no startup do Next via import. Se variável crítica
 * está faltando, lança erro com mensagem clara antes do app subir.
 *
 * Uso: import { env } from "@/lib/env";
 */

import { z } from "zod";

const isProd = process.env.NODE_ENV === "production";

/**
 * Em produção exigimos todas as vars críticas. Em dev, algumas são opcionais
 * pra permitir setup parcial (ex: dev sem WAHA quando trabalhando só na UI).
 */
const required = (name: string) =>
  isProd
    ? z.string().min(1, `${name} é obrigatória em produção`)
    : z.string().default("");

const requiredAlways = (name: string) => z.string().min(1, `${name} é obrigatória`);

const schema = z.object({
  // Node
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // Supabase — obrigatórias sempre (até pra dev local)
  NEXT_PUBLIC_SUPABASE_URL: requiredAlways("NEXT_PUBLIC_SUPABASE_URL").url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: requiredAlways("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  SUPABASE_SERVICE_ROLE_KEY: requiredAlways("SUPABASE_SERVICE_ROLE_KEY"),

  // Cron / interno
  INTERNAL_SECRET: required("INTERNAL_SECRET"),
  /** Optional dedicated secret for cron endpoints (S-06.07 onwards). */
  INTERNAL_CRON_SECRET: z.string().optional().default(""),

  // Encryption keys (pgcrypto)
  CPF_ENCRYPTION_KEY: required("CPF_ENCRYPTION_KEY"),
  NUVEMSHOP_OAUTH_ENCRYPTION_KEY: required("NUVEMSHOP_OAUTH_ENCRYPTION_KEY"),
  WAHA_BYO_ENCRYPTION_KEY: required("WAHA_BYO_ENCRYPTION_KEY"),

  // WAHA
  WAHA_API_BASE_URL: required("WAHA_API_BASE_URL"),
  WAHA_API_KEY: required("WAHA_API_KEY"),
  WAHA_WEBHOOK_BASE_URL: required("WAHA_WEBHOOK_BASE_URL"),

  // Upstash Redis
  UPSTASH_REDIS_REST_URL: required("UPSTASH_REDIS_REST_URL"),
  UPSTASH_REDIS_REST_TOKEN: required("UPSTASH_REDIS_REST_TOKEN"),

  // AI providers — env-gated. Worker no-ops with skip="ai_gateway_key_missing"
  // when AI_GATEWAY_API_KEY is absent, so production boot must not be fatal.
  AI_GATEWAY_API_KEY: z.string().optional().default(""),
  AI_GATEWAY_BASE_URL: z.string().optional().default(""),
  VERCEL_AI_GATEWAY_URL: z.string().optional().default(""),
  ANTHROPIC_API_KEY: z.string().optional().default(""),
  OPENAI_API_KEY: z.string().optional().default(""),

  // Workers — opt-in via env so dev doesn't run loops. Production cron sets it.
  EVENT_LOG_WORKER_ENABLED: z
    .enum(["true", "false"])
    .optional()
    .default("false")
    .transform((v) => v === "true"),

  // Sentry
  SENTRY_DSN: z.string().optional().default(""),

  // EPIC-11 Impersonate cookie HMAC secret. Optional at boot (route returns
  // 503 at runtime if missing/short); required in prod for the feature to
  // function. Min 32 chars when present is enforced at use site.
  IMPERSONATE_COOKIE_SECRET: z.string().optional().default(""),

  // LGPD export (S-08.04)
  LGPD_SIGNING_KEY: z.string().optional().default(""),
  LGPD_EXPORT_EXPIRES_HOURS: z.string().optional().default("72"),
  LGPD_DPO_EMAIL: z.string().optional().default(""),

  // Nuvemshop
  NUVEMSHOP_APP_ID: required("NUVEMSHOP_APP_ID"),
  NUVEMSHOP_CLIENT_ID: required("NUVEMSHOP_CLIENT_ID"),
  NUVEMSHOP_CLIENT_SECRET: required("NUVEMSHOP_CLIENT_SECRET"),

  // App URLs
  NEXT_PUBLIC_APP_URL: z
    .string()
    .url()
    .default("http://localhost:3000"),
  NEXT_PUBLIC_ADMIN_URL: z
    .string()
    .url()
    .default("http://localhost:3000"),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // Log estruturado pra debug. Sentry capturaria via uncaught.
  console.error("[env] Falha de validação de variáveis de ambiente:");
  console.error(parsed.error.flatten().fieldErrors);
  throw new Error(
    "Variáveis de ambiente inválidas. Veja o erro acima e ajuste .env.local / Vercel.",
  );
}

export const env = parsed.data;

// Soft warning for env-gated AI keys (worker degrades gracefully but operators
// should know when the bot is silent for config reasons).
if (!env.AI_GATEWAY_API_KEY && !env.ANTHROPIC_API_KEY) {
  console.warn(
    "[env] No AI_GATEWAY_API_KEY or ANTHROPIC_API_KEY set — ai-response-worker will skip with reason='ai_gateway_key_missing'.",
  );
}
if (!env.OPENAI_API_KEY) {
  console.warn(
    "[env] No OPENAI_API_KEY set — RAG embedding will be unavailable; bot answers without retrieved context.",
  );
}
if (!env.IMPERSONATE_COOKIE_SECRET || env.IMPERSONATE_COOKIE_SECRET.length < 32) {
  console.warn(
    "[env] IMPERSONATE_COOKIE_SECRET not set or shorter than 32 chars — impersonate flow will return 503 at runtime.",
  );
}

export type Env = typeof env;
