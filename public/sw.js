/*
 * Service worker mínimo do ZapInbox.
 *
 * Objetivo v1: habilitar a instalação (PWA) e uma casca offline simples, SEM
 * cachear API/auth (evita bugs de dado velho). Navegações usam network-first
 * com fallback pra uma página offline; assets de build (/_next/static, imutáveis)
 * usam cache-first. Base pronta pra Web Push depois.
 */
const CACHE = "zapinbox-shell-v1";
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll([OFFLINE_URL, "/icon-192.png"])),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // Nunca intercepta API/auth/realtime — sempre rede.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) return;

  // Assets imutáveis do build: cache-first.
  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icon-")) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const clone = res.clone();
        caches.open(CACHE).then((c) => c.put(req, clone));
        return res;
      })),
    );
    return;
  }

  // Navegações: network-first, fallback offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() => caches.match(OFFLINE_URL).then((r) => r || Response.error())),
    );
  }
});
