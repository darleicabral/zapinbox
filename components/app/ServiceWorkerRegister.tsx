"use client";

import { useEffect } from "react";

/**
 * Registra o service worker (public/sw.js) no cliente — habilita instalação
 * (PWA) + casca offline. No-op em navegadores sem suporte ou em dev sem HTTPS.
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    const onLoad = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        /* falha de registro não pode quebrar o app */
      });
    };
    if (document.readyState === "complete") onLoad();
    else window.addEventListener("load", onLoad, { once: true });
    return () => window.removeEventListener("load", onLoad);
  }, []);

  return null;
}
