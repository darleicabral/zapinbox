/**
 * DSN do Sentry com opt-out em runtime — modelo "telemetria de comunidade".
 *
 * Por padrão, erros vão pro Sentry do projeto (DEFAULT_SENTRY_DSN): num open source
 * self-host, é o que dá visibilidade pra corrigir bugs que afetam todo mundo. Quem
 * hospeda controla isso pelo `.env`, SEM rebuild da imagem:
 *
 *   SENTRY_DSN=off           → desliga toda a telemetria (nada é enviado)
 *   SENTRY_DSN=<seu-dsn>     → manda os erros pro SEU Sentry
 *   SENTRY_DSN=  (vazio)     → usa o Sentry da comunidade (padrão)
 *
 * Vale para servidor (process.env) e navegador (window.__PUBLIC_ENV__.SENTRY_DSN,
 * injetado em runtime pelo <PublicEnvScript/>). O DSN não é segredo — DSNs do Sentry
 * são públicos por design.
 */
export const DEFAULT_SENTRY_DSN =
  "https://58fabf8ad54504863d404a3647ef3714@o4509908078559232.ingest.us.sentry.io/4509908083212288";

export function resolveSentryDsn(value: string | undefined | null): string | undefined {
  const v = (value ?? "").trim().toLowerCase() === "off" ? "off" : (value ?? "").trim();
  if (v === "off" || v === "false" || v === "0") return undefined;
  return v.length > 0 ? v : DEFAULT_SENTRY_DSN;
}
