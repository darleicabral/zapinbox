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

export type HandoffSource = "sentinel" | "tool" | "promessa" | "adiamento";

/**
 * O lead avisou QUANDO pode falar, em vez de responder.
 *
 * Regra do Darlei (04/09/2026): "quando ele usar esses termos mais tarde,
 * depois, à noite, ocupado, no trabalho, a gente tem que passar pro corretor e
 * deixar isso avisado no resumo de IA".
 *
 * Nasceu do print do Marcos: ele disse "Eu estou no trabalho" e o bot seguiu
 * qualificando, enquanto a cadência o cobrava a cada 6 minutos. Quem avisa a
 * hora está dando um dado de agenda, e isso é assunto de corretor, não de bot.
 *
 * Cada padrão devolve também o RECADO que vai no aviso, porque "está no
 * trabalho agora" e "pediu pra falar à noite" mudam a ação do corretor.
 */
/**
 * Sem `\b` de propósito: em JS a fronteira de palavra é ASCII, então `\bà` e
 * `amanhã\b` NUNCA casam (foi o que quebrou "à noite" e "amanhã" no primeiro
 * teste). As frases aqui são específicas o bastante pra dispensar âncora.
 */
const AVISOS_DE_AGENDA: { rx: RegExp; recado: string }[] = [
  {
    rx: /(?:^|[^\p{L}])(estou|est[oô]|t[oô]) no (trabalho|trampo)/iu,
    recado: "O lead está no trabalho agora e avisou que não pode falar.",
  },
  {
    rx: /(?:^|[^\p{L}])(estou|est[oô]|t[oô]) (meio )?ocupad[oa]|sem tempo agora/iu,
    recado: "O lead avisou que está ocupado agora.",
  },
  {
    rx: /mais tarde|depois eu (te )?(falo|chamo|respondo)|te (falo|chamo) depois|depois a gente (fala|conversa)/iu,
    recado: "O lead pediu pra falar mais tarde.",
  },
  {
    rx: /[aà] noite|de noite|fim da tarde|depois do (trabalho|servi[cç]o)|quando (eu )?sair do trabalho/iu,
    recado: "O lead pediu pra falar no fim do dia.",
  },
  {
    rx: /(amanh[aã]|na segunda|no s[aá]bado)[^.!?]{0,20}(a gente|eu (te )?(falo|chamo|vejo)|conversamos)/iu,
    recado: "O lead pediu pra retomar em outro dia.",
  },
];

/** Pura. Devolve o recado pro corretor, ou null quando não é aviso de agenda. */
export function avisoDeAgenda(textoDoLead: string): string | null {
  const t = (textoDoLead ?? "").trim();
  if (!t) return null;
  for (const { rx, recado } of AVISOS_DE_AGENDA) {
    if (rx.test(t)) return `${recado} Ele escreveu: "${t.slice(0, 120)}"`;
  }
  return null;
}

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
  /** Recado do lead que vai no aviso do corretor. */
  observacao?: string | null;
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
      observacao: input.observacao ?? null,
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
