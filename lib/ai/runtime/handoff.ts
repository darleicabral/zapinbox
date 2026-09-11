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
 *
 * A lista está em MOTIVOS_NA_FALA_DO_LEAD, mais abaixo.
 */

/**
 * O lead RECLAMANDO que ninguém responde.
 *
 * ⚠️ A frase do Bruno é INVERTIDA: "vocês respondem não". Um regex que só
 * procurasse "não responde" perdia justamente a reclamação mais raivosa do lote,
 * então as duas ordens entram.
 *
 * Exportado porque TRÊS lugares precisam da mesma leitura, e uma cópia
 * divergente seria pior que o problema: aqui vira encaminhamento; na cadência
 * (followup.ts) garante que reclamação NÃO seja lida como desistência; e na
 * cobrança do corretor (recobrar.ts) é a única coisa que autoriza acordar
 * alguém.
 */
export const RECLAMACAO_DE_ABANDONO_RX =
  /n[ãa]o (me )?respond|n[ãa]o (me )?atend|respondem?\s+n[ãa]o|atendem?\s+n[ãa]o|n[ãa]o fala nada|ningu[eé]m (me )?(respond|atend)|sem resposta (at[ée]|ainda)|cad[êe] (voc[êe]s?|vcs?)|(t[ôo]|estou) esperando (resposta|h[áa]|ha )/iu;

/** O lead está cobrando resposta? Pura. */
export function leadReclamouDeAbandono(texto: string | null | undefined): boolean {
  const t = (texto ?? "").trim();
  return t.length > 0 && RECLAMACAO_DE_ABANDONO_RX.test(t);
}

/**
 * Sem `\b` de propósito: em JS a fronteira de palavra é ASCII, então `\bà` e
 * `amanhã\b` NUNCA casam (foi o que quebrou "à noite" e "amanhã" no primeiro
 * teste). As frases aqui são específicas o bastante pra dispensar âncora.
 */
const MOTIVOS_NA_FALA_DO_LEAD: { rx: RegExp; recado: string }[] = [
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
    // 🐛 10/09/2026 — "BOA NOITE" CONTÉM "A NOITE", e por isso toda saudação
    // noturna virava "o lead pediu pra falar no fim do dia" e encaminhava o
    // lead antes de o bot ter qualificado nada. Pior caso real: "Boa noite pode
    // me dizer qual é a metragem do apartamento??" — pergunta simples, que o
    // bot responde, mandada pro corretor. Das 6 falas que casaram com este
    // padrão desde 01/09, QUATRO eram só a saudação.
    //
    // O lookbehind `(?<!bo)` separa saudação de intenção: "Boa noite" não
    // aciona, "me chama a noite" e "hoje a noite" continuam acionando.
    rx: /(?<!bo)[aà] noite|de noite|fim da tarde|depois do (trabalho|servi[cç]o)|quando (eu )?sair do trabalho/iu,
    recado: "O lead pediu pra falar no fim do dia.",
  },
  {
    rx: /(amanh[aã]|na segunda|no s[aá]bado)[^.!?]{0,20}(a gente|eu (te )?(falo|chamo|vejo)|conversamos)/iu,
    recado: "O lead pediu pra retomar em outro dia.",
  },
  // 05/09/2026, regra do Darlei: "se pedirem o endereco completo, ja pode passar
  // direto para o corretor sem ficar pedindo autorizacao do lead". No print o
  // lead insistiu no endereco e a IA ficou perguntando se podia chamar alguem.
  //
  // "localizacao" sozinho NAO entra de proposito: a essa o bot responde com o
  // bairro, que e informacao boa e nao precisa de humano. Aqui e endereco de
  // rua, numero, ou o pin do mapa.
  {
    rx: /endere[çc]o|qual (é )?(a )?rua|nome da rua|n[uú]mero da casa|localiza[çc][ãa]o (exata|completa|precisa)|(manda|envia|passa|mandar|enviar)[^.!?]{0,12}localiza[çc][ãa]o/iu,
    recado: "O lead pediu o ENDEREÇO do imóvel — quem passa endereço e marca visita é você.",
  },
  // ── 08/09: padroes achados lendo as 19 conversas que escaparam em 04-06/09 ──
  {
    // "Apos as 19:00 horas!" — dar HORA e agendar visita, e agenda e sua.
    rx: /(?:^|[^\d])([01]?\d|2[0-3])\s*(?:h(?:oras?)?\b|:\s*[0-5]\d)/iu,
    recado: "O lead deu um horário — ele está marcando a visita.",
  },
  {
    // acessibilidade: "eu sou analfabeta", "nao sei ler". Caso do contato 🫛.
    rx: /analfabet|n[ãa]o sei ler|n[ãa]o consigo ler|s[oó] por [aá]udio/iu,
    recado: "O lead não lê texto e precisa de ÁUDIO ou ligação — fale com ele por voz.",
  },
  {
    // pede FOTO ou VIDEO pra gente. Lookbehind exclui "vou te mandar uma foto".
    rx: /(?<!vou )(?<!vou te )(manda|mande|envia|envie|passa|passe)[^.!?]{0,14}(fotos?|v[ií]deos?)|(fotos?|v[ií]deos?)[^.!?]{0,10}(por favor|pra mim)/iu,
    recado: "O lead pediu FOTO ou VÍDEO do imóvel — quem manda é você.",
  },
  {
    // confusao: "Eu nao entendi direito." O bot repetia a pergunta padrao.
    rx: /n[ãa]o entendi|n[ãa]o compreendi|n[ãa]o ficou claro|como assim\?|voc[êe] [ée] (um )?rob[oô]|[ée] rob[oô]\?/iu,
    recado: "O lead não entendeu a conversa com a IA.",
  },
  // ── 09/09: RECLAMACAO DE ABANDONO. O estado mais raivoso que existe, e ate
  // hoje sem gatilho nenhum. Quatro casos numa semana, todos com o lead
  // querendo comprar:
  //   Bruno   "A gente fala sim, voces respondem nao. Pelo amor de Deus, gente."
  //   Roger   "Vcs nao respondem" (e, seis minutos depois, "?????")
  //   Waldeir "Estou mas vc nao fala nada"
  //   Valone  "Bom dia tenho interesse, so que nao me responde as mensagens"
  //
  // O MESMO texto e reconhecido na cadencia (RECLAMACAO_DE_ABANDONO em
  // followup.ts) pro efeito OPOSTO: garantir que reclamacao nao seja lida como
  // desistencia. Aqui ele escala. As duas leituras dizem a mesma coisa — esse
  // lead quer atencao, nao quer sair.
  {
    rx: RECLAMACAO_DE_ABANDONO_RX,
    recado:
      "🚨 O lead RECLAMOU que ninguém responde. Fale com ele agora — ele está irritado e ainda quer comprar.",
  },
];

/**
 * A fala do lead já pede corretor? Pura. Devolve o recado, ou null.
 *
 * Duas famílias hoje: aviso de agenda (ele disse quando pode falar) e pedido de
 * endereço (é o corretor que passa endereço e marca a visita).
 */
export function motivoDoLeadParaEncaminhar(textoDoLead: string): string | null {
  const t = (textoDoLead ?? "").trim();
  if (!t) return null;
  for (const { rx, recado } of MOTIVOS_NA_FALA_DO_LEAD) {
    if (rx.test(t)) return `${recado} Ele escreveu: "${t.slice(0, 120)}"`;
  }
  return null;
}

/**
 * Frases em que o bot PARA sem resolver: promete humano, promete voltar com uma
 * resposta que nunca vem, ou fica esperando o cliente trazer a data da visita.
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
const PARADAS_SEM_SOLUCAO: { rx: RegExp; recado: string }[] = [
  // ── promete humano e não chama ninguém (o caso do Ronaldo, 04/09) ──
  {
    rx: /s[oó] um momento|j[aá] te retorno|j[aá] confirmo isso|ficar[aá] pronta em instantes/i,
    recado: "A IA pediu pro cliente esperar e não voltou.",
  },
  {
    rx: /com a equipe|prefiro que o corretor|quem te (passa|explica) certinho|vou (te )?(encaminhar|passar) (pro|pra|para)|vou chamar (o|a) (corretor|consultor)/i,
    recado: "A IA disse ao cliente que alguém da equipe assumiria.",
  },
  // ── 05/09: não soube responder e ficou de voltar ──
  // "Você tem terrenos menor?" / "Boa pergunta! Deixa eu ver o que temos em
  // terrenos menores por aqui pra te passar certinho." E não voltou.
  {
    rx: /deixa eu (ver|confirmar|checar|conferir|dar uma olhada)|vou (ver|verificar|checar|conferir|dar uma olhada)|te (passar|passo|mandar|mando).{0,12}certinho/i,
    recado: "A IA não soube responder a pergunta e ficou de retornar.",
  },
  // ── 05/09: visita que não fechou ──
  // "Vou me organizar e te retorno" / "Fechado! Vou deixar anotado... me chama
  // que eu já confirmo a agenda." Ninguém marcou nada, e a cadência foi cobrar.
  {
    rx: /quando (voc[êe] )?(confirmar|decidir|souber|tiver certeza)|me chama (que|quando)|vou deixar anotado|t[oô] (por )?aqui pra/i,
    recado: "O cliente quer visitar, mas a IA não fechou dia e horário.",
  },
  // ── 08/09, achados nas 19 que escaparam ──
  {
    // A FRASE DO PROTOCOLO dita SEM chamar a ferramenta. O pior caso do lote:
    // a Grazi tinha visita pra "amanha a tarde" e ninguem foi avisado.
    rx: /s[oó] confirmando aqui a disponibilidade|confirmando (aqui )?a agenda|vou confirmar a agenda/i,
    recado: "A IA disse ao cliente que ia CONFIRMAR A AGENDA da visita — confirme com ele.",
  },
  {
    // mesma familia de espera, palavras que faltavam: "um instante", "ja volto".
    rx: /um instante|um minuto|j[aá] volto|volto (j[aá]|em seguida)|aguarda (um|ai)/i,
    recado: "A IA pediu pro cliente esperar e não voltou.",
  },
];

/**
 * O bot ENCERROU o turno sem resolver? Devolve o recado pro corretor, ou null.
 *
 * Regra do Darlei (05/09/2026), com dois prints: "a IA não deveria insistir
 * assim, poderia passar para o corretor. Ele disse que quer visitar, mas o
 * agente não conseguiu agendar" e "nesse aqui a IA não soube responder a
 * pergunta, passe ao corretor também".
 *
 * SÓ O ÚLTIMO PARÁGRAFO, e é isso que separa parada de muleta. Quando é muleta
 * o bot continua e responde ("Deixa eu confirmar essa casa no catálogo." +
 * "Confirmei aqui: é ..."), e a frase fica no meio. Quando ele para de verdade,
 * ela é a última coisa dita. Sem esse recorte, 24 de 27 execuções medidas em
 * 04/09 cairiam aqui e o bot seria silenciado à toa.
 */
export function botParouSemResolver(texto: string): string | null {
  const partes = (texto ?? "")
    .split(/\n[ \t]*\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const ultima = partes[partes.length - 1] ?? "";
  if (!ultima) return null;
  // Terminar PERGUNTANDO não é parar: "Quer que eu chame ele agora?" espera a
  // resposta do lead, e acionar ali silenciaria o bot antes de o cliente dizer
  // se quer. Emoji no fim é comum, então sai antes de olhar o "?".
  const semEmoji = ultima.replace(/[\s\p{Extended_Pictographic}️‍]+$/gu, "");
  if (semEmoji.endsWith("?")) return null;
  for (const { rx, recado } of PARADAS_SEM_SOLUCAO) {
    if (rx.test(ultima)) return recado;
  }
  return null;
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

/**
 * Quem ficou com o lead. Devolvido pra que o RUNTIME possa dizer ao cliente
 * quem vai atendê-lo — ver o aviso obrigatório em agent.ts.
 *
 * `null` em assignedFirstName significa que ninguém foi atribuído (rodízio
 * desligado ou sem corretor livre): o texto cai pra "nossa equipe já te chama".
 */
export interface DesfechoDoHandoff {
  assignedFirstName: string | null;
}

export async function finalizeHandoff(
  input: FinalizeHandoffInput,
): Promise<DesfechoDoHandoff> {
  // 🐛 10/09/2026 — CORRETOR RECEBENDO O MESMO LEAD DUAS VEZES.
  //
  // Quando o handoff vem da FERRAMENTA (`source === "tool"`), o efeito colateral
  // JA ACONTECEU: `lib/mcp/tools/handoff.ts` chama triggerHandoff, e o passo 6
  // do orquestrador atribui o corretor e manda o aviso. Chamar de novo aqui
  // mandava o segundo aviso ~10 segundos depois, no meio da mensagem de
  // despedida do bot.
  //
  // Medido nos avisos desde 05/09: 45 de 162 eram duplicata (28%), com
  // intervalos de 7 a 23 segundos. A trava de idempotência do orquestrador não
  // pegava, por dois motivos: a janela dela é de 5 segundos, e ela exige o
  // MESMO motivo — a ferramenta manda "requested_human" e o runtime manda o
  // texto do motivo, então nunca casavam.
  //
  // Aqui a função volta a fazer só o que o cabeçalho dela promete: marcar o
  // run. Os outros gatilhos (sentinela, promessa, adiamento) continuam
  // disparando o efeito, porque neles ninguém disparou antes.
  const efeitoJaAconteceu = input.source === "tool";

  let assignedFirstName: string | null = null;
  if (input.conversationId && !input.isDryRun && !efeitoJaAconteceu) {
    const leadId = await findLeadIdForConversation(input.organizationId, input.conversationId);
    const resultado = await triggerHandoff({
      conversationId: input.conversationId,
      organizationId: input.organizationId,
      reason: input.reason,
      leadId,
      observacao: input.observacao ?? null,
      metadata: { run_id: input.runId, source: input.source },
    });
    assignedFirstName = resultado.assignedFirstName ?? null;
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

  return { assignedFirstName };
}

/**
 * O texto que o cliente PRECISA receber quando o sistema encaminha.
 *
 * 🐛 11/09/2026 — A JUNIA MARIA FICOU FALANDO SOZINHA. Ela perguntou "Qual a
 * sua disponibilidade?", o bot respondeu e perguntou "Qual dia fica melhor pra
 * você?", e 2 segundos depois o sistema encaminhou pro corretor e silenciou o
 * bot pra sempre. Ela respondeu DUAS vezes ("Posso te mandar da segunda?" e "VC
 * teria outras unidades TMB na região?") sem nunca saber que alguém ia atendê-la.
 *
 * Medido em todos os handoffs da Avant: 16 leads foram encaminhados sem ouvir
 * quem vai atender, e 13 deles continuaram falando no vazio.
 *
 * Por que só acontece fora da ferramenta: quando o MODELO chama a tool, ele sabe
 * que está encaminhando e escreve a despedida certa. Nos gatilhos de sistema
 * (sentinela, promessa, adiamento) quem decide é o código, DEPOIS que o modelo
 * já escreveu — e o texto dele foi escrito supondo que a conversa continuava.
 *
 * O formato segue o que o prompt já manda (seção "COMO FUNCIONA O
 * ENCAMINHAMENTO"): cita o nome quando existe, e nunca inventa um.
 */
export function avisoDeQuemVaiAtender(assignedFirstName: string | null): string {
  return assignedFirstName
    ? `Vou te encaminhar pro ${assignedFirstName}, nosso corretor. Ele já te chama aqui 👍`
    : "Vou te encaminhar pra nossa equipe. Já te chamam aqui 👍";
}

/**
 * A despedida que o modelo escreveu já cumpre o contrato?
 *
 * Se ele mesmo disse que ia passar pra alguém, repetir soa como robô travado.
 * Só quando ele NÃO disse é que o sistema completa.
 */
const JA_DISSE_QUEM_ATENDE =
  /vou te (encaminhar|passar)|te encaminho|nossa equipe j[áa] te chama|j[áa] te chama|o corretor[^.!?]{0,30}(te chama|entra em contato)|s[óo] um momento/iu;

export function precisaAvisarQuemAtende(despedidaDoModelo: string | null | undefined): boolean {
  const t = (despedidaDoModelo ?? "").trim();
  if (!t) return true;
  return !JA_DISSE_QUEM_ATENDE.test(t);
}
