/**
 * Sliding-window history loader for ai_agent_runs (S-13.08).
 *
 * Loads the last `messageWindow` messages of the conversation (chronological,
 * oldest-first) and trims to fit `tokenWindow`. Token estimation is the
 * cheap-and-cheerful len/4 heuristic — within the noise of the runtime budget.
 *
 * ⚠️ AUTORIA IMPORTA. Toda saída era mapeada como `assistant`, inclusive a que um
 * CORRETOR HUMANO digitou. O modelo então lia as falas do corretor como se
 * fossem dele. Medido em produção (03/09/2026, conversa 2c699951): o bot mandou
 * "*Gilvam:* O consultor vai atender você no número 31 99295-3088" — copiou o
 * prefixo e se passou por uma pessoa da equipe na frente da cliente. Na mesma
 * conversa escreveu "Desculpa, me perdi um pouco no fio aqui 😅", porque as
 * "próprias" mensagens anteriores não batiam com a política dele.
 *
 * Agora a mensagem de humano é rotulada, então o modelo sabe que não foi ele.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LoadHistoryInput {
  conversationId: string;
  organizationId: string;
  messageWindow: number;
  tokenWindow: number;
  /** Exclude the inbound that triggered the run (we add it explicitly later). */
  excludeMessageId?: string;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * O composer do CRM prefixa a mensagem com o nome de quem enviou ("*Gilvam:* oi").
 * Tira o prefixo pra o nome não virar padrão de escrita pro modelo, e devolve o
 * nome separado pra compor o rótulo.
 */
export function splitSenderPrefix(text: string): { sender: string | null; body: string } {
  const m = text.match(/^\*([^*\n]{1,40})[:：]\*\s*/);
  if (!m) return { sender: null, body: text };
  return { sender: m[1]!.trim(), body: text.slice(m[0].length).trim() };
}

/** Quem escreveu a saída: o próprio bot, ou uma pessoa da equipe. */
export function isHumanSent(sentVia: string | null | undefined): boolean {
  // null/'ai'/'system' = plataforma. Legado sem sent_via conta como bot, que é o
  // comportamento antigo — melhor que rotular tudo como humano por engano.
  return sentVia === "user" || sentVia === "external_device";
}

/** Uma linha de `messages` virando turno pro modelo. Pura, pra ser testável. */
export function toHistoryTurn(row: {
  body: string | null;
  direction: string;
  sent_via?: string | null;
}): HistoryMessage {
  const texto = (row.body ?? "").trim();
  if (row.direction === "inbound") return { role: "user", content: texto };

  if (!isHumanSent(row.sent_via)) return { role: "assistant", content: texto };

  // Saída escrita por humano: rotula e tira o prefixo do nome. O rótulo entre
  // parênteses evita o que aconteceu com o "*Gilvam:*", que o modelo copiou
  // achando que era o formato dele.
  const { sender, body } = splitSenderPrefix(texto);
  const quem = sender ? `o corretor ${sender}` : "um corretor da equipe";
  return {
    role: "assistant",
    content: `(mensagem enviada por ${quem}, não foi você — não copie este formato) ${body}`,
  };
}

export async function loadHistoryWithBudget(
  supabase: SupabaseClient,
  input: LoadHistoryInput,
): Promise<HistoryMessage[]> {
  const limit = Math.max(input.messageWindow, 1);
  const { data, error } = await supabase
    .from("messages")
    .select("id, body, direction, sent_at, sent_via")
    .eq("organization_id", input.organizationId)
    .eq("conversation_id", input.conversationId)
    .order("sent_at", { ascending: false })
    .limit(limit);

  if (error || !data) return [];

  const filtered = (data as Array<{
    id: string;
    body: string | null;
    direction: string;
    sent_at: string;
    sent_via: string | null;
  }>)
    .filter((m) => m.id !== input.excludeMessageId)
    .filter((m) => (m.body ?? "").trim().length > 0);

  // Sort oldest-first, then trim greedily from the back so newest messages stay.
  filtered.reverse();

  let totalTokens = 0;
  const kept: HistoryMessage[] = [];
  for (let i = filtered.length - 1; i >= 0; i--) {
    const m = filtered[i]!;
    const turno = toHistoryTurn(m);
    const tokens = estimateTokens(turno.content);
    if (totalTokens + tokens > input.tokenWindow) break;
    totalTokens += tokens;
    kept.unshift(turno);
  }

  return kept;
}
