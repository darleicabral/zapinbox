/**
 * Thin WAHA send helper exposed for the agent runtime (S-13.08).
 *
 * The runtime uses `sendMessageHandler` for the production path (handles WAHA
 * dispatch + outbound message row + ack + retries), so this module is a small
 * convenience for direct callers (tests, smoke checks). Returns null when
 * WAHA env is not configured — callers must treat that as a noop, not error.
 */
import { getWahaClient } from "./client";

export interface SendWahaInput {
  sessionName: string;
  chatId: string;
  text: string;
}

export interface ResolveWahaChatIdInput {
  isGroup: boolean;
  groupChatId: string | null;
  phoneNumber: string | null | undefined;
  /** `contacts.wa_identity` (migration 0027): 'phone:+E164' | 'lid:<digits>' | null. */
  waIdentity: string | null | undefined;
}

/**
 * Resolves the WAHA-addressable chat id for a 1:1 or group conversation.
 * Falls back to the `lid:<digits>` identity (migration 0027) when the
 * contact has no `phone_number` — WhatsApp's privacy-mode contacts (Linked
 * ID) never expose a real phone number, but WAHA/NOWEB still accepts sending
 * to `<digits>@lid`.
 */
export function resolveWahaChatId(input: ResolveWahaChatIdInput): string | null {
  if (input.isGroup && input.groupChatId) return input.groupChatId;
  if (input.phoneNumber) return `${input.phoneNumber.replace(/\D/g, "")}@c.us`;
  if (input.waIdentity?.startsWith("lid:")) return `${input.waIdentity.slice(4)}@lid`;
  return null;
}

export async function sendWAHA(input: SendWahaInput): Promise<unknown | null> {
  const client = getWahaClient();
  if (!client) return null;
  return client.sendMessage(input.sessionName, input.chatId, input.text);
}

/**
 * Escolhe entre o chatId ingenuo (so digitos + @c.us) e o que o WhatsApp diz
 * ser o real. Puro, pra dar pra testar.
 *
 * - WAHA fora do ar (resposta null): devolve o ingenuo. Nao piora o que havia.
 * - numero nao existe no WhatsApp: devolve null pra NAO enviar no vazio.
 * - existe: manda no chatId canonico (e o que resolve o nono digito).
 */
export function escolherChatId(
  ingenuo: string | null,
  resposta: { numberExists?: boolean; chatId?: string | null } | null,
): string | null {
  if (!resposta) return ingenuo;
  if (resposta.numberExists === false) return null;
  const canonico = typeof resposta.chatId === "string" ? resposta.chatId.trim() : "";
  return canonico || ingenuo;
}

/**
 * Igual ao resolveWahaChatId, mas CONFERINDO no WhatsApp. Use sempre que o
 * numero foi digitado por uma pessoa (ex.: o telefone de aviso do corretor).
 * Conversa de lead nao precisa: o JID dela veio do proprio WhatsApp.
 */
export async function resolveChatIdChecked(input: {
  sessionName: string;
  phoneNumber: string | null;
}): Promise<string | null> {
  const ingenuo = resolveWahaChatId({
    isGroup: false,
    groupChatId: null,
    phoneNumber: input.phoneNumber,
    waIdentity: null,
  });
  if (!ingenuo || !input.phoneNumber) return ingenuo;
  const client = getWahaClient();
  if (!client) return ingenuo;
  const digitos = input.phoneNumber.replace(/\D/g, "");
  let resposta: { numberExists: boolean; chatId: string | null } | null = null;
  try {
    resposta = await client.checkExists(input.sessionName, digitos);
  } catch {
    return ingenuo; // falha de rede nao pode calar a notificacao
  }
  return escolherChatId(ingenuo, resposta);
}
