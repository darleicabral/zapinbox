/**
 * Handoff finalizer for the agent runtime (S-13.08).
 *
 * Wraps lib/ai/handoff/orchestrator.triggerHandoff and stamps the run row with
 * status='handoff'. Três origens:
 *   - 'sentinel'         keyword regex on inbound (no LLM call, cost=0)
 *   - 'tool'             agent invoked crm_request_human_handoff during the loop
 *   - 'promessa'         o modelo PROMETEU humano e não chamou a tool (abaixo)
 */
import { triggerHandoff, type HandoffReason } from "@/lib/ai/handoff/orchestrator";
import { createAdminClient } from "@/lib/supabase/admin";
import { finalizeRun, type FinalizeRunInput } from "./finalize";

export type HandoffSource = "sentinel" | "tool" | "promessa";

/**
 * Frases em que o bot promete que OUTRA PESSOA (ou ele mesmo, depois) resolve.
 *
 * 🐛 04/09/2026 — o lead perguntou sobre permuta e o bot respondeu "Boa
 * pergunta, deixa eu confirmar isso certinho com a equipe" SEM chamar a tool de
 * encaminhamento: `last_handoff_at` nulo, nenhum corretor avisado, zero
 * ferramenta no run. O lead esperou 33 minutos, o follow-up o trouxe de volta,
 * ele disse "Sim" e o bot enrolou de novo ("Já te retorno, tô finalizando uma
 * coisa aqui"). Ninguém foi chamado nas duas vezes.
 *
 * É o sintoma da aderência a ferramenta que medimos em 03/09 (~25% de uso no
 * DeepSeek contra ~75% no Sonnet). Outra regra no prompt não resolve: quem
 * promete humano aqui passa a ser honrado pelo SISTEMA.
 */
const ESPERA_SEM_VOLTA: RegExp[] = [
  /s[oó] um momento/i,
  /j[aá] te retorno/i,
  /j[aá] confirmo isso/i,
  /com a equipe/i,
  /prefiro que o corretor/i,
  /quem te (passa|explica) certinho/i,
  /ficar[aá] pronta em instantes/i,
  // "pro" além de "pra/para": o bot escreve "vou te encaminhar PRO Gilvam"
  /vou (te )?(encaminhar|passar) (pro|pra|para)/i,
  /vou chamar (o|a) (corretor|consultor)/i,
];

/**
 * Só olha o ÚLTIMO parágrafo, e é isso que separa promessa de muleta.
 *
 * Nos dados: quando é muleta o bot continua e responde ("Deixa eu confirmar
 * certinho essa casa no catálogo." + "Confirmei aqui: é ..."), e a espera fica
 * no meio. Quando é abandono, a espera é a última coisa dita. Sem esse recorte,
 * 24 de 27 execuções cairiam aqui e o bot seria silenciado à toa.
 */
export function prometeuHumano(texto: string): boolean {
  const partes = texto
    .split(/\n[ \t]*\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const ultima = partes[partes.length - 1] ?? "";
  if (!ESPERA_SEM_VOLTA.some((rx) => rx.test(ultima))) return false;
  // Terminar PERGUNTANDO não é prometer: "quem te passa certinho é o corretor.
  // Quer que eu chame ele agora?" espera a resposta do lead. Acionar ali
  // silenciaria o bot antes de o cliente dizer se quer, e um "não, deixa"
  // ficaria sem resposta. Emoji no fim é comum, então sai antes de olhar o "?".
  const semEmoji = ultima.replace(/[\s\p{Extended_Pictographic}️‍]+$/gu, "");
  return !semEmoji.endsWith("?");
}

export interface FinalizeHandoffInput {
  runId: string;
  organizationId: string;
  conversationId: string | null;
  reason: HandoffReason;
  source: HandoffSource;
  latencyMs?: number;
  tokensIn?: number;
  tokensOut?: number;
  costCents?: number;
  stepsCount?: number;
  toolCalls?: FinalizeRunInput["toolCalls"];
  isDryRun?: boolean;
}

async function findLeadIdForConversation(
  organizationId: string,
  conversationId: string,
): Promise<string | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("crm_lead_links")
    .select("lead_id")
    .eq("organization_id", organizationId)
    .eq("target_kind", "conversation")
    .eq("target_id", conversationId)
    .maybeSingle();
  return (data?.lead_id as string | undefined) ?? null;
}

export async function finalizeHandoff(input: FinalizeHandoffInput): Promise<void> {
  // Trigger external side effects only when we have a real conversation
  // (test/dry-run flows pass null and just want the run row marked).
  if (input.conversationId && !input.isDryRun) {
    const leadId = await findLeadIdForConversation(input.organizationId, input.conversationId);
    await triggerHandoff({
      conversationId: input.conversationId,
      organizationId: input.organizationId,
      reason: input.reason,
      leadId,
      metadata: { run_id: input.runId, source: input.source },
    });
  }

  await finalizeRun({
    runId: input.runId,
    organizationId: input.organizationId,
    status: "handoff",
    abortReason: `${input.source}:${input.reason}`,
    latencyMs: input.latencyMs,
    tokensIn: input.tokensIn ?? 0,
    tokensOut: input.tokensOut ?? 0,
    costCents: input.costCents ?? 0,
    stepsCount: input.stepsCount ?? 0,
    toolCalls: input.toolCalls,
    isDryRun: input.isDryRun,
  });
}
