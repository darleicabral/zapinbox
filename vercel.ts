/**
 * Vercel project config (canonical TS form).
 *
 * Crons placeholder; lista final virá da Spec 08 (Operações & Workers).
 * Os 7 crons abaixo refletem os jobs derivados das specs herdadas:
 *  - recover-stuck-messages (WAHA)
 *  - sync-sessions (WAHA)
 *  - process-pending-webhooks (event_log)
 *  - dispatch-webhooks (deliveries / outbound webhooks)
 *  - lgpd-data-request-worker (D+7 SLA)
 *  - nuvemshop-sync-incremental
 *  - audit-log-archive (cold storage)
 *
 * Auth de cron: header `Authorization: Bearer ${INTERNAL_SECRET}` validado em cada handler.
 */

import type { VercelConfig } from "@vercel/config/v1";

const config: VercelConfig = {
  crons: [
    { path: "/api/v1/cron/lgpd-sla-watcher", schedule: "0 12 * * *" },
    // EPIC-13 S-13.07: drains ai_agent.dispatch_requested events. Vercel cron
    // cannot go sub-minute; per-minute batch of 100 events is sized for the
    // MVP target tenant (~300 inbound/day, headroom ~6k/hour).
    //
    // [ZapInbox] Plano Hobby da Vercel só permite cron DIÁRIO — agendado 1x/dia
    // como fallback. O disparo por-minuto real virá do crontab da VPS Hostgator:
    //   * * * * * curl -s -X POST https://<app>/api/v1/cron/agent-dispatcher \
    //       -H "Authorization: Bearer $INTERNAL_SECRET"
    // (ou upgrade p/ Vercel Pro e voltar este schedule p/ "*/1 * * * *").
    { path: "/api/v1/cron/agent-dispatcher", schedule: "30 3 * * *" },
    // [ZapInbox] Drena o event_log (message.received → ai-response-worker etc.).
    // Rota criada por nós — o fork prometia mas nunca implementou. Mesmo
    // esquema do agent-dispatcher: fallback diário aqui, tick por-minuto real
    // no crontab da VPS:
    //   * * * * * curl -s -X POST https://crm.zapinbox.com.br/api/v1/cron/event-log-drain \
    //       -H "Authorization: Bearer $INTERNAL_SECRET"
    { path: "/api/v1/cron/event-log-drain", schedule: "35 3 * * *" },
    // [ZapInbox] C4 — SLA de atendimento (repasse por rodízio + alerta gestor).
    // Idem: fallback diário; tick por-minuto real no crontab da VPS:
    //   * * * * * curl -s -X POST https://crm.zapinbox.com.br/api/v1/cron/attendance-sla \
    //       -H "Authorization: Bearer $INTERNAL_SECRET"
    { path: "/api/v1/cron/attendance-sla", schedule: "40 3 * * *" },
  ],
  functions: {
    // EPIC-13 S-13.08: ToolLoopAgent runtime can issue multiple tool calls per
    // step. 300s max keeps Fluid Compute within bounds; the runtime's own
    // step/token/cost guards usually finish much earlier.
    "app/api/internal/agents/run/route.ts": { maxDuration: 300 },
    // event-log-drain roda LLM+embeddings por evento — mesmo teto do runner.
    "app/api/v1/cron/event-log-drain/route.ts": { maxDuration: 300 },
  },
};

export default config;
