/**
 * Minimal WAHA REST client used during onboarding (and elsewhere). Returns
 * `null` from `getWahaClient()` when env is not configured so callers can
 * gracefully render a "Docker is not up" banner instead of crashing.
 *
 * WAHA Plus auth: `X-Api-Key` header. The current devlikeapro/waha-plus
 * image expects the SHA512 HEX HASH directly in the header (matches what's
 * stored in container env). Plaintext-then-hash is NOT used in this version.
 * So WAHA_API_KEY in .env.local IS the hex hash.
 */
export class WahaClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  /**
   * Idempotent: ensures session exists, then starts it.
   * WAHA Plus split the API:
   *   POST /api/sessions               → create (422 if exists)
   *   POST /api/sessions/{name}/start  → start (422 if already starting/working)
   */
  async startSession(name: string): Promise<{ qr?: string; status: string }> {
    // 1) Create session (ignore 422/409 = already exists)
    const createRes = await fetch(`${this.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "X-Api-Key": this.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ name, config: {} }),
    });
    if (!createRes.ok && createRes.status !== 422 && createRes.status !== 409) {
      const body = await createRes.text().catch(() => "");
      throw new Error(`waha_create_${createRes.status}: ${body.slice(0, 200)}`);
    }

    // 2) Start session
    const startRes = await fetch(`${this.baseUrl}/api/sessions/${encodeURIComponent(name)}/start`, {
      method: "POST",
      headers: { "X-Api-Key": this.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!startRes.ok && startRes.status !== 422 && startRes.status !== 409) {
      const body = await startRes.text().catch(() => "");
      throw new Error(`waha_start_${startRes.status}: ${body.slice(0, 200)}`);
    }
    if (startRes.status === 422 || startRes.status === 409) {
      // Already started — fetch and return current state
      return this.getSessionQr(name);
    }
    return (await startRes.json()) as { qr?: string; status: string };
  }

  /**
   * Stop a session. Idempotent: 404 (unknown) / 422 / 409 (already stopped)
   * are treated as success so callers can compose reconnect = stop + start.
   */
  async stopSession(name: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/sessions/${encodeURIComponent(name)}/stop`, {
      method: "POST",
      headers: { "X-Api-Key": this.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!res.ok && ![404, 422, 409].includes(res.status)) {
      const body = await res.text().catch(() => "");
      throw new Error(`waha_stop_${res.status}: ${body.slice(0, 200)}`);
    }
  }

  async getSessionQr(name: string): Promise<{ qr?: string; status: string }> {
    const res = await fetch(`${this.baseUrl}/api/sessions/${encodeURIComponent(name)}`, {
      headers: { "X-Api-Key": this.apiKey },
    });
    if (!res.ok) throw new Error(`waha_${res.status}`);
    return (await res.json()) as { qr?: string; status: string };
  }

  async sendMessage(session: string, chatId: string, text: string): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}/api/sendText`, {
      method: "POST",
      headers: {
        "X-Api-Key": this.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ session, chatId, text }),
    });
    if (!res.ok) throw new Error(`waha_${res.status}`);
    return res.json();
  }

  /**
   * Envia arquivo em base64 (decisão Darlei 26/07: sem guardar cópia no nosso
   * storage). O endpoint muda com o mime porque o WhatsApp trata cada um de um
   * jeito: imagem vira foto no chat, áudio ogg/opus vira mensagem de voz, o
   * resto vai como documento.
   */
  async sendMedia(
    session: string,
    chatId: string,
    file: { mimetype: string; filename: string; base64: string },
    caption?: string,
  ): Promise<unknown> {
    const isImage = file.mimetype.startsWith("image/");
    const isVoice = /^audio\/(ogg|opus)/.test(file.mimetype);
    const endpoint = isImage ? "sendImage" : isVoice ? "sendVoice" : "sendFile";

    const res = await fetch(`${this.baseUrl}/api/${endpoint}`, {
      method: "POST",
      headers: {
        "X-Api-Key": this.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        session,
        chatId,
        file: { mimetype: file.mimetype, filename: file.filename, data: file.base64 },
        ...(caption && !isVoice ? { caption } : {}),
      }),
    });
    if (!res.ok) throw new Error(`waha_${res.status}`);
    return res.json();
  }

  /** Baixa a mídia recebida (a URL vem do webhook e exige a API key). */
  async fetchMedia(url: string): Promise<Response> {
    return fetch(url, { headers: { "X-Api-Key": this.apiKey } });
  }

  /** Base do WAHA — usada para provar que uma URL de mídia é mesmo dele. */
  get origin(): string {
    return this.baseUrl;
  }
}

/**
 * A mídia recebida vem no endereço INTERNO do WAHA — ele reporta
 * `http://localhost:3000/api/files/...`, que é o localhost DELE, não o nosso.
 * De fora isso não resolve (ECONNREFUSED), e a rota de mídia do CRM ainda
 * rejeitava por origem inválida: foto e áudio de cliente ficavam invisíveis
 * pro corretor (descoberto em 03/09/2026 medindo os áudios sem resposta).
 *
 * Reescreve só a ORIGEM, preservando o caminho, e nunca confia no host que veio
 * no payload — o que também fecha a porta pra SSRF. Caminho de forma
 * desconhecida volta cru, pra nunca perder a URL se o WAHA mudar de layout.
 */
export function publicWahaMediaUrl(
  raw: string | null | undefined,
  base: string,
): string | null {
  if (!raw) return null;
  let caminho: string;
  try {
    const u = new URL(raw);
    caminho = u.pathname + u.search;
  } catch {
    return raw;
  }
  if (!caminho.startsWith("/api/files/")) return raw;
  return base.replace(/\/+$/, "") + caminho;
}

/**
 * Traduz erros crus do WAHA (fetch failed, ECONNREFUSED, timeout) numa
 * mensagem clara para o usuário. Usado quando o container não está no ar.
 */
export function wahaFriendlyError(msg: string): string {
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|und_err|network|timeout|socket|EAI_AGAIN/i.test(msg)) {
    return "O serviço do WhatsApp (WAHA) não está respondendo. Confirme que o container está no ar e tente de novo.";
  }
  return `Falha na comunicação com o WhatsApp (WAHA): ${msg}`;
}

/**
 * Returns a configured client or null. Null means the WAHA Docker isn't up
 * or the env is using the dev placeholder; the UI must render a banner
 * prompting the user to start it.
 */
export function getWahaClient(): WahaClient | null {
  const url = process.env.WAHA_API_BASE_URL;
  const key = process.env.WAHA_API_KEY;
  if (!url || !key || key === "dev_plaintext_change_me") return null;
  return new WahaClient(url, key);
}
