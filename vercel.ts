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
    { path: "/api/v1/cron/recover-stuck-messages", schedule: "*/5 * * * *" },
    { path: "/api/v1/cron/sync-sessions", schedule: "*/15 * * * *" },
    { path: "/api/v1/cron/process-pending-webhooks", schedule: "* * * * *" },
    { path: "/api/v1/cron/dispatch-webhooks", schedule: "* * * * *" },
    { path: "/api/v1/cron/lgpd-data-request-worker", schedule: "0 * * * *" },
    { path: "/api/v1/cron/nuvemshop-sync-incremental", schedule: "0 */6 * * *" },
    { path: "/api/v1/cron/audit-log-archive", schedule: "0 3 * * *" },
  ],
};

export default config;
