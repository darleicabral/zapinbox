/**
 * Copiar pra área de transferência com DUAS versões do mesmo conteúdo: HTML
 * (Gmail/Outlook colam formatado) e texto puro (WhatsApp, Bloco de Notas).
 *
 * Ordem dos fallbacks importa: `ClipboardItem` não existe em navegador antigo e
 * `navigator.clipboard` não existe fora de contexto seguro (http). Por isso a
 * cadeia termina no textarea + execCommand, que é depreciado mas é o único que
 * funciona nesses casos — sem ele o botão simplesmente não faria nada.
 *
 * Chame SEM await antes, no próprio handler do clique: o navegador só libera a
 * área de transferência durante o gesto do usuário.
 */
export async function copyRichText(text: string, html: string): Promise<boolean> {
  try {
    if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([text], { type: "text/plain" }),
          "text/html": new Blob([html], { type: "text/html" }),
        }),
      ]);
      return true;
    }
  } catch {
    // cai pro texto puro
  }

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // cai pro textarea
  }

  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
