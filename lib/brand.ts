/**
 * Marca visual por organização (white-label de cores).
 *
 * O produto é sempre "ZapInbox"; o que muda por tenant é a PALETA aplicada via
 * atributo `data-brand` (ver os blocos em `app/globals.css`). Tenants sem marca
 * própria caem no default ZapInbox (verde). A Avant usa a paleta vinho do print.
 *
 * NÃO confundir com tema claro/escuro (`data-theme`) — as duas dimensões são
 * independentes e se combinam (ex.: Avant + dark).
 */
export type Brand = "zapinbox" | "avant";

/** Resolve a marca a partir do slug da organização ativa. */
export function brandForOrg(slug?: string | null): Brand {
  return slug === "avant" ? "avant" : "zapinbox";
}
