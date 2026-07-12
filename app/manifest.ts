import type { MetadataRoute } from "next";

/**
 * Web App Manifest — torna o CRM instalável na tela inicial do celular
 * (corretores são mobile-first). Next serve isto em /manifest.webmanifest e
 * injeta o <link rel="manifest"> automaticamente.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "ZapInbox — Atendimento",
    short_name: "ZapInbox",
    description: "Atenda seus leads de WhatsApp direto do celular.",
    start_url: "/app/inbox",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    lang: "pt-BR",
    background_color: "#059669",
    theme_color: "#059669",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
