"use client";
import { useEffect } from "react";
import type { Brand } from "@/lib/brand";

/**
 * Espelha o `data-brand` no `<body>` para que conteúdo montado em portais
 * (toasts do Sonner, popovers/menus do Radix — que anexam no `document.body`,
 * fora do wrapper do AppShell) herde a paleta da marca ativa.
 *
 * Vai no `<body>` (não no `<html>`) de propósito: `data-theme` vive no `<html>`,
 * então manter as duas dimensões em elementos distintos deixa o seletor
 * `[data-theme="dark"] [data-brand="avant"]` casar via combinador descendente
 * (um compound no mesmo elemento é descartado pelo otimizador de CSS).
 *
 * A UI principal já recebe o `data-brand` via SSR no wrapper do AppShell (sem
 * flash de cor); este efeito cobre só os portais. No unmount remove o atributo
 * para que admin/login/onboarding voltem ao ZapInbox (default do :root).
 */
export function BrandSync({ brand }: { brand: Brand }) {
  useEffect(() => {
    const el = document.body;
    if (brand === "zapinbox") {
      el.removeAttribute("data-brand");
    } else {
      el.setAttribute("data-brand", brand);
    }
    return () => {
      el.removeAttribute("data-brand");
    };
  }, [brand]);

  return null;
}
