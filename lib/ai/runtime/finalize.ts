/**
 * Finalize/persist helpers for the agent runtime (S-13.08).
 *
 * `finalizeRun` stamps the row, emits domain event + audit log.
 * `sendFinalResponse` reuses `sendMessageHandler` (which knows about WAHA,
 * outbound row insert, retry, idempotency_keys) so we never duplicate
 * dispatch logic here.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import type { Actor } from "@/lib/api/handlers/types";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import type { SerializedStep } from "./serialize";

export type RunStatus = "completed" | "failed" | "aborted" | "handoff";

export interface FinalizeRunInput {
  runId: string;
  organizationId: string;
  status: RunStatus;
  tokensIn?: number;
  tokensOut?: number;
  costCents?: number;
  latencyMs?: number;
  stepsCount?: number;
  toolCalls?: SerializedStep[];
  finalText?: string | null;
  outboundMessageId?: string | null;
  abortReason?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  isDryRun?: boolean;
}

export async function finalizeRun(input: FinalizeRunInput): Promise<void> {
  const admin = createAdminClient();
  const completedAt = new Date().toISOString();

  const updateRow: Record<string, unknown> = {
    status: input.status,
    completed_at: completedAt,
  };
  if (input.tokensIn !== undefined) updateRow.tokens_in = input.tokensIn;
  if (input.tokensOut !== undefined) updateRow.tokens_out = input.tokensOut;
  if (input.costCents !== undefined) updateRow.cost_cents = input.costCents;
  if (input.latencyMs !== undefined) updateRow.latency_ms = input.latencyMs;
  if (input.stepsCount !== undefined) updateRow.steps_count = input.stepsCount;
  if (input.toolCalls !== undefined) updateRow.tool_calls = input.toolCalls;
  if (input.outboundMessageId !== undefined) updateRow.outbound_message_id = input.outboundMessageId;
  if (input.abortReason !== undefined) updateRow.abort_reason = input.abortReason;
  if (input.errorCode !== undefined) updateRow.error_code = input.errorCode;
  if (input.errorMessage !== undefined) {
    updateRow.error_message = (input.errorMessage ?? "").slice(0, 500);
  }

  await admin
    .from("ai_agent_runs")
    .update(updateRow)
    .eq("id", input.runId)
    .eq("organization_id", input.organizationId);

  // Domain event (best-effort).
  const eventType =
    input.status === "completed"
      ? "ai_agent.run_completed"
      : input.status === "handoff"
        ? "ai_agent.handoff_triggered"
        : "ai_agent.run_failed";

  await admin.rpc("emit_event" as never, {
    p_event_type: eventType,
    p_entity_kind: "ai_agent_run",
    p_entity_id: input.runId,
    p_payload: {
      run_id: input.runId,
      status: input.status,
      tokens_in: input.tokensIn ?? 0,
      tokens_out: input.tokensOut ?? 0,
      cost_cents: input.costCents ?? 0,
      latency_ms: input.latencyMs ?? null,
      steps_count: input.stepsCount ?? 0,
      abort_reason: input.abortReason ?? null,
      is_dry_run: input.isDryRun ?? false,
    },
    p_metadata: { source: "agent-runtime" },
    p_organization_id: input.organizationId,
  } as never);

  // Audit log (fire-and-forget).
  const auditAction =
    input.status === "completed" || input.status === "handoff"
      ? "ai_agent.run_completed"
      : "ai_agent.run_failed";
  void audit({
    action: auditAction,
    organizationId: input.organizationId,
    resourceType: "ai_agent_run",
    resourceId: input.runId,
    metadata: {
      status: input.status,
      abort_reason: input.abortReason ?? null,
      error_code: input.errorCode ?? null,
      tokens_in: input.tokensIn ?? 0,
      tokens_out: input.tokensOut ?? 0,
      cost_cents: input.costCents ?? 0,
      latency_ms: input.latencyMs ?? null,
      steps_count: input.stepsCount ?? 0,
      is_dry_run: input.isDryRun ?? false,
    },
  });
}

export interface SendFinalResponseInput {
  supabase: SupabaseClient;
  organizationId: string;
  runId: string;
  conversationId: string;
  text: string;
  requestId: string;
}

/** No máximo isto de mensagens por resposta, pra não metralhar o cliente. */
export const MAX_BALOES = 5;
/** Pausa entre balões: preserva a ordem no WhatsApp e imita digitação. */
const PAUSA_ENTRE_BALOES_MS = 800;

/**
 * Divide a resposta do modelo em balões separados de WhatsApp.
 *
 * Pedido do Darlei (03/09/2026): a IA já pula uma linha quando troca de assunto,
 * e o natural é que isso vire OUTRA mensagem, como pessoa digitando, em vez de um
 * bloco só. O próprio prompt manda "nunca envie um balão com mais de 2 linhas",
 * mas o runtime enviava tudo junto e a regra não tinha efeito nenhum.
 *
 * Corta só em LINHA EM BRANCO. Quebra de linha simples fica junto de propósito:
 * é o que mantém "Opção 1 📍 Apartamento, Floramar / 2 quartos · R$ 380.000" num
 * balão só. Acima de MAX_BALOES o resto vai junto no último, pra não virar
 * enxurrada de notificação no celular do lead.
 */
/**
 * Marcadores de RACIOCÍNIO do modelo — texto que ele escreveu pensando, não
 * falando com o cliente.
 *
 * 🐛 04/09/2026 — o lead recebeu isto no WhatsApp, entre a saudação e a
 * resposta: "O cliente falou genericamente 'fazendinhas', sem especificar qual.
 * Tenho duas opções de fazendinhas no catálogo. Vou esclarecer qual ele quer
 * antes de mandar o roteiro fixo." O DeepSeek delibera dentro do próprio texto
 * da resposta, e o divisor mandava os parágrafos fielmente.
 *
 * Os padrões são conservadores de propósito. O bot fala COM o cliente ("você"),
 * nunca SOBRE ele em terceira pessoa, e nunca cita nome de ferramenta nem termo
 * interno do prompt. Um "por conta do cliente" solto NÃO cai aqui: exige verbo
 * de fala ou de vontade por perto, que é o que caracteriza a deliberação.
 */
const MARCADORES_DE_RACIOCINIO: RegExp[] = [
  /\b[oa]s? (cliente|lead|usuári[oa])\b[^.!?]{0,80}\b(falou|disse|pediu|perguntou|mencionou|quer|queria|escolheu|especificou|respondeu)\b/i,
  /\b(falou|disse|pediu|perguntou|mencionou|quer|queria)\b[^.!?]{0,40}\b[oa]s? (cliente|lead|usuári[oa])\b/i,
  /\bcrm_[a-z_]+\b/i,
  /\broteiro fixo\b|\bbase de conhecimento\b|\bhandoff\b|\bprompt\b/i,
  /\b(vou|preciso|devo)\b[^.!?]{0,40}\b(antes de (mandar|responder|enviar)|esclarecer qual|confirmar qual)\b/i,
];

/** Pura, pra dar pra testar sem banco. */
export function pareceRaciocinio(paragrafo: string): boolean {
  return MARCADORES_DE_RACIOCINIO.some((rx) => rx.test(paragrafo));
}

export function splitIntoBalloons(text: string, maxPartes = MAX_BALOES): string[] {
  const brutas = text
    .split(/\n[ \t]*\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const limpas = brutas.filter((p) => !pareceRaciocinio(p));
  // Se TUDO pareceu raciocínio, manda como veio: um balão estranho é melhor
  // que silêncio, e o falso positivo geral vira bug visível em vez de mudo.
  const partes = limpas.length > 0 ? limpas : brutas;
  if (partes.length !== brutas.length) {
    logger.warn("[finalize] parágrafo de raciocínio descartado", {
      descartados: brutas.length - partes.length,
      total: brutas.length,
    });
  }
  if (partes.length <= maxPartes) return partes;
  const cabeca = partes.slice(0, maxPartes - 1);
  const resto = partes.slice(maxPartes - 1).join("\n\n");
  return [...cabeca, resto];
}

const dorme = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Inserts an outbound message + dispatches via WAHA via existing
 * sendMessageHandler. Returns the FIRST message id (or null on failure).
 *
 * Uma resposta pode virar VÁRIAS mensagens (ver splitIntoBalloons). O id
 * devolvido é o do primeiro balão, que é o que identifica a resposta no run.
 */
export async function sendFinalResponse(
  input: SendFinalResponseInput,
): Promise<string | null> {
  if (!input.text || input.text.trim().length === 0) return null;

  const actor: Actor = {
    type: "ai_agent",
    id: input.runId,
    role: "agent",
  };
  const baloes = splitIntoBalloons(input.text);
  let primeiroId: string | null = null;

  for (let i = 0; i < baloes.length; i++) {
    // Pausa só ENTRE balões. A ordem importa: mensagem fora de ordem no
    // WhatsApp fica pior que bloco único.
    if (i > 0) await dorme(PAUSA_ENTRE_BALOES_MS);
    try {
      const message = await sendMessageHandler(
        input.supabase,
        {
          organization_id: input.organizationId,
          actor,
          requestId: i === 0 ? input.requestId : `${input.requestId}-b${i}`,
        },
        {
          conversation_id: input.conversationId,
          type: "text",
          body: baloes[i]!,
          metadata: {
            run_id: input.runId,
            ai_actor_id: input.runId,
            // rastro pra depurar resposta partida em vários balões
            balloon_index: i,
            balloon_total: baloes.length,
          },
        },
      );
      if (i === 0) primeiroId = message.id;
    } catch (err) {
      // Falha no 1º balão = resposta perdida, devolve null como antes. Falha num
      // balão do meio: o que já saiu não volta atrás, então loga e para de
      // insistir, pra não mandar o fim da conversa sem o começo.
      console.error(`[agent-runtime] sendFinalResponse falhou no balão ${i + 1}/${baloes.length}`, err);
      break;
    }
  }

  return primeiroId;
}
