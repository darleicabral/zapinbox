"use client";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";

interface Props {
  organizationId: string;
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

type Status = "unsupported" | "no_key" | "loading" | "off" | "on" | "denied";

/**
 * Liga/desliga a notificação nativa (Web Push) deste aparelho. Uma assinatura
 * por aparelho/navegador — o corretor ativa no celular (PWA instalado) e
 * recebe o aviso de lead mesmo com o app fechado.
 */
export function PushToggleCard({ organizationId }: Props) {
  const [status, setStatus] = useState<Status>("loading");
  const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";

  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
      setStatus("unsupported");
      return;
    }
    if (!vapidKey) {
      setStatus("no_key");
      return;
    }
    if (Notification.permission === "denied") {
      setStatus("denied");
      return;
    }
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => setStatus(sub ? "on" : "off"))
      .catch(() => setStatus("off"));
  }, [vapidKey]);

  async function enable() {
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setStatus(permission === "denied" ? "denied" : "off");
        if (permission === "denied") toast.error("Permissão de notificação negada no navegador.");
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      });
      const json = sub.toJSON();
      const res = await fetch("/api/v1/push/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organization_id: organizationId,
          endpoint: sub.endpoint,
          keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth },
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus("on");
      toast.success("Notificações ativadas neste aparelho.");
    } catch (err) {
      toast.error(`Não foi possível ativar: ${err instanceof Error ? err.message : String(err)}`);
      setStatus("off");
    }
  }

  async function disable() {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await fetch("/api/v1/push/subscriptions", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
      setStatus("off");
      toast.success("Notificações desativadas neste aparelho.");
    } catch (err) {
      toast.error(`Erro ao desativar: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (status === "unsupported" || status === "no_key") {
    return (
      <Card className="p-4 text-sm text-muted-foreground">
        {status === "unsupported"
          ? "Este navegador não suporta notificações push. No iPhone, instale o app na tela inicial (Compartilhar → Adicionar à Tela de Início) e ative por lá."
          : "Notificações push não configuradas no servidor."}
      </Card>
    );
  }

  return (
    <Card className="flex items-center justify-between gap-4 p-4">
      <div>
        <div className="text-sm font-medium">Notificações neste aparelho</div>
        <p className="mt-1 text-xs text-muted-foreground">
          {status === "denied"
            ? "Bloqueadas no navegador — libere nas permissões do site para ativar."
            : "Aviso nativo quando um lead for atribuído a você, mesmo com o app fechado. Ative no celular com o app instalado (PWA)."}
        </p>
      </div>
      <Switch
        checked={status === "on"}
        disabled={status === "loading" || status === "denied"}
        onCheckedChange={(v) => (v ? enable() : disable())}
        aria-label="Ativar notificações push neste aparelho"
      />
    </Card>
  );
}
