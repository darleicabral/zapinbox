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

export async function sendWAHA(input: SendWahaInput): Promise<unknown | null> {
  const client = getWahaClient();
  if (!client) return null;
  return client.sendMessage(input.sessionName, input.chatId, input.text);
}
