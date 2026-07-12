"use client";

/**
 * C4 — Heartbeat de presença: com o app aberto, marca o atendente como
 * 'online' a cada 60s (POST /api/v1/presence). Aba oculta continua pingando
 * (atendente pode estar noutra janela); fechar o app interrompe o heartbeat e
 * o rodízio o considera offline por staleness (PRESENCE_FRESH_MS).
 */
import { useEffect } from "react";

const HEARTBEAT_MS = 60_000;

export function PresenceHeartbeat({ organizationId }: { organizationId: string | null }) {
  useEffect(() => {
    if (!organizationId) return;

    let stopped = false;
    const ping = () => {
      if (stopped) return;
      void fetch("/api/v1/presence", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organization_id: organizationId, presence: "online" }),
        keepalive: true,
      }).catch(() => {
        // Falha de rede não pode quebrar o app; próximo tick tenta de novo.
      });
    };

    ping();
    const timer = setInterval(ping, HEARTBEAT_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [organizationId]);

  return null;
}
