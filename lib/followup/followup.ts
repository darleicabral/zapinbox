/**
 * C1 — Follow-up por inatividade (cadência de reengajamento), consumido pelo
 * cron `/api/v1/cron/inactivity-followup`.
 *
 * Regras (cadencia-reengajamento.md da Avant):
 *  - Só roda com o BOT ainda no comando (conversa 'open'/'ai_handling', não
 *    silenciada). Transferida pra equipe ("Só um momento") → não roda.
 *  - PARA quando um corretor já foi avisado (conversa com `assigned_to_user_id`):
 *    o aviso vai pro WhatsApp pessoal dele e ele continua o atendimento do
 *    próprio número, então cutucar o lead só atrapalha. Atribuído e esquecido é
 *    problema do SLA (lib/attendance/sla.ts), não do reengajamento.
 *  - PARA quando um humano respondeu depois da última mensagem do lead (corretor
 *    que digita direto, sem passar o bastão pelo bot).
 *  - Lead responde → a próxima entrada resetá `followup_step` (last_inbound_at
 *    passa a ser > last_followup_at) e a cadência recomeça.
 *  - Etapas por tenant (`followup_settings.steps`): cada uma dispara quando a
 *    inatividade (agora − last_inbound_at) cruza `after_minutes`. Etapa com
 *    `discard:true` encerra: move o lead pra "perdido" e resolve a conversa.
 *  - Respeita expediente, opt-out (contato bloqueado por STOP) e throttle.
 *
 * Service-role: filtra organization_id em toda query.
 */
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import {
  inBusinessHours,
  minutosDesdeAberturaDaJanela,
  type BusinessHours,
} from "@/lib/attendance/rotation";

import { logger } from "@/lib/logger";

export interface FollowupStep {
  after_minutes: number;
  message: string;
  discard?: boolean;
}

interface FollowupSettings {
  organization_id: string;
  enabled: boolean;
  /** Instante da última ATIVAÇÃO. A cadência só pega conversa criada depois. */
  enabled_at: string | null;
  throttle_seconds: number;
  business_hours: BusinessHours | null;
  steps: FollowupStep[];
}

export interface FollowupSweepSummary {
  orgs_scanned: number;
  sent: number;
  discarded: number;
  reset: number;
  /** Cadencia encerrada porque o lead recusou (ver leadRecusou). */
  recusados: number;
  errors: string[];
}

interface ConvRow {
  id: string;
  created_at: string;
  contact_id: string | null;
  status: string;
  last_inbound_at: string | null;
  /** Nossa ultima fala. Se for mais antiga que a dele, DEVEMOS uma resposta. */
  last_outbound_at: string | null;
  last_followup_at: string | null;
  followup_step: number;
  bot_silenced_until: string | null;
  /** Dono da conversa. Preenchido = corretor já foi avisado, cadência para. */
  assigned_to_user_id: string | null;
  contacts: {
    display_name: string | null;
    is_blocked: boolean;
    force_human: boolean;
    /** Telefone da equipe: a conversa existe pro histórico, mas não é lead. */
    is_internal: boolean | null;
  } | null;
}

/**
 * A mensagem saiu da CADENCIA, e nao e resposta de ninguem.
 *
 * 🐛 09/09/2026 — o furo da trava de 08/09. A cadencia envia pelo
 * sendMessageHandler, que atualiza `last_outbound_at`. Ou seja: o primeiro toque
 * mexe no proprio relogio que a trava consulta, e do segundo em diante ela
 * SEMPRE passa. A trava barrava um toque e liberava os proximos quatro.
 *
 * Medido nas conversas de 03 a 09/09: 19 leads escreveram, NUNCA receberam uma
 * resposta de verdade, e levaram 141 toques. O Waldeir levou 25. Cinco deles
 * receberam toque hoje as 9h em ponto, na abertura do expediente.
 *
 * Mensagem nova leva a marca em `metadata.followup_step`. Pro acervo que nao
 * tem marca, comparar com os textos das etapas resolve — sao frases fixas de
 * configuracao, com {nome} como unico buraco.
 */
export function ehMensagemDaCadencia(
  body: string | null | undefined,
  metadata: Record<string, unknown> | null | undefined,
  steps: FollowupStep[],
): boolean {
  if (metadata && metadata.followup_step !== undefined && metadata.followup_step !== null) {
    return true;
  }
  const t = chaveDeTexto(body ?? "");
  if (!t) return false;
  return steps.some((s) => {
    const molde = chaveDeTexto(s.message);
    if (!molde) return false;
    // {nome} vira buraco: compara o que vem antes e depois do placeholder.
    const partes = molde.split(chaveDeTexto("{nome}"));
    if (partes.length === 2) {
      return t.startsWith(partes[0]!) && t.endsWith(partes[1]!);
    }
    return t === molde;
  });
}

function chaveDeTexto(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Mn}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9{} ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * O lead RECUSOU. Cutucar depois disso e importunar.
 *
 * Pedido do Darlei (09/09/2026), olhando a conversa do Ronaldo Costa: as 09h07
 * ele respondeu "Bom dia, nao obrigado" a oferta de simulacao, o bot se
 * despediu bem ("Tranquilo, sem problema") — e as 09h13 a cadencia perguntou
 * "Oi, ainda ta por ai?".
 *
 * Duas camadas, porque o vocabulario da recusa e ambiguo:
 *
 *  1. RECUSA QUE SE EXPLICA SOZINHA, vale em qualquer contexto: "nao obrigado",
 *     "nao tenho interesse", "so tava olhando", "desisti", "ja comprei".
 *
 *  2. RECUSA QUE SO EXISTE COMO RESPOSTA A UMA OFERTA: "nao", "ok obrigado",
 *     "obrigado", "valeu". Um "nao" solto no meio da conversa costuma ser
 *     resposta a uma pergunta do bot ("ja tem financiamento?" / "conhece o
 *     bairro?") e nao recusa de nada. Mas TODA etapa da cadencia termina numa
 *     oferta, entao "nao" respondendo a um toque e recusa da oferta.
 *
 * O que NAO pode ser lido como recusa, tirado das falas reais desta semana:
 * "Vcs nao respondem", "vc nao fala nada", "nao me responde as mensagens" (sao
 * RECLAMACOES de abandono — o lead quer atencao, nao quer sair), "nao entendi
 * direito" (confusao), "Vc anuncia uma casa e nao sabe o endereco?" (pergunta),
 * "E nao queria sair da regua", "Se nao for no capela".
 */
const RECUSA_SOZINHA =
  /(n[ãa]o,? (muito )?obrigad|n[ãa]o obg|n[ãa]o,? valeu|n[ãa]o (tenho|ha|há) interesse|sem interesse|n[ãa]o me interessa|n[ãa]o (quero|queria) (mais|nada)|n[ãa]o vou querer|n[ãa]o pretendo|desisti|ja (comprei|resolvi|consegui|achei|fechei)|j[áa] (comprei|resolvi|consegui|achei|fechei)|s[óo] (tava|estava|estou|to|tô) (olhando|vendo|dando uma olhada)|n[ãa]o me atende|n[ãa]o preciso mais|pode (cancelar|encerrar)|me (tira|remove))/i;

const ENCERRAMENTO_APOS_OFERTA =
  /^(n[ãa]o|nada|nops?|negativo|ok,?\s*obrigad\w*|obrigad\w*|valeu|vlw|tranquilo|de nada|blz|beleza|t[áa] (bom|certo)|agradeço|agradecido)[\s.!]*$/i;

/** Reclamacao de abandono: o oposto de recusa, ainda que cheia de "nao". */
const RECLAMACAO_DE_ABANDONO =
  /(n[ãa]o (me )?respond|n[ãa]o fala nada|ningu[eé]m respond|n[ãa]o me atender|sem resposta|cad[êe] (voc|vc))/i;

export function leadRecusou(
  texto: string | null | undefined,
  opts: { respondendoACadencia: boolean },
): boolean {
  const t = (texto ?? "").trim();
  if (!t) return false;
  if (RECLAMACAO_DE_ABANDONO.test(t)) return false;
  if (RECUSA_SOZINHA.test(t)) return true;
  return opts.respondendoACadencia && ENCERRAMENTO_APOS_OFERTA.test(t);
}

/**
 * Idade máxima da última mensagem do lead pra a cadência COMEÇAR.
 *
 * Existe por causa do incidente de 03/09/2026: ligar o reengajamento sobre o
 * acervo mandou 116 mensagens pra 34 conversas em 5 minutos, porque conversa
 * parada há horas já cruzou o prazo de todas as etapas. "Oi, ainda tá por aí?"
 * só faz sentido minutos depois do lead sumir, não dias. Em operação normal isto
 * nunca pega: a cadência começa poucos minutos depois do silêncio.
 */
const MAX_IDADE_PARA_INICIAR_MIN = 180;

/**
 * Silêncio mínimo pra cobrar DE NOVO quem já respondeu a um follow-up.
 *
 * 🐛 04/09/2026 — o Marcos recebeu 4 mensagens da cadência. Ele respondeu "Eu
 * estou no trabalho" às 09h09, e às 09h15 o sistema perguntou "Oi, ainda tá por
 * aí?" — passando por cima de uma pergunta que o bot tinha acabado de fazer.
 * Dos 9 leads que receberam follow-up naquela manhã, 2 responderam, e os DOIS
 * foram cobrados de novo.
 *
 * Causa: quando o lead responde, a cadência reinicia do zero, e a etapa 1 exige
 * só 5 minutos. Esses 5 minutos servem pra quem clicou no anúncio e desapareceu,
 * não pra quem está conversando e respondendo do trabalho. Quem respondeu não é
 * lead silencioso: a barra sobe pra uma hora.
 */
const MIN_SILENCIO_APOS_RESPOSTA_MIN = 60;

/**
 * O lead respondeu DEPOIS do nosso último follow-up? Pura, pra ser testável.
 *
 * Sem `last_followup_at` a cadência ainda não falou com ele, então não há o que
 * "responder" — e a etapa 1 segue valendo com o prazo normal.
 */
export function respondeuAoUltimoFollowup(
  lastInboundAt: string | null,
  lastFollowupAt: string | null,
): boolean {
  if (!lastFollowupAt || !lastInboundAt) return false;
  return new Date(lastInboundAt).getTime() > new Date(lastFollowupAt).getTime();
}

/**
 * A conversa entra na cadência, dado o instante da ATIVAÇÃO do reengajamento?
 *
 * Decisão do Darlei (03/09/2026): ao ativar, a cadência vale APENAS pra lead
 * novo, criado a partir daquele momento. Conversa que já existia fica fora pra
 * sempre, mesmo que o lead volte a escrever — o corte é a CRIAÇÃO da conversa,
 * não a última mensagem. Sem isso, ligar varre o acervo: em 03/09 foram 116
 * mensagens pra 34 conversas paradas, em cinco minutos.
 *
 * `enabledAt` nulo (tenant legado) devolve false de propósito: melhor exigir que
 * o gestor ative de novo, marcando o corte, do que mandar em massa.
 */
export function conversaElegivelPorAtivacao(
  conversaCriadaEm: string,
  enabledAt: string | null,
): boolean {
  if (!enabledAt) return false;
  return new Date(conversaCriadaEm).getTime() > new Date(enabledAt).getTime();
}

/**
 * A etapa `indice` pode disparar agora? Pura, pra ser testável sem banco.
 *
 * Duas regras nasceram do incidente de 03/09/2026 (116 mensagens em 34 conversas
 * em 5 minutos ao ligar a cadência sobre o acervo):
 *
 *  1. `after_minutes` sozinho não basta. Ele mede o silêncio DO LEAD, e lead
 *     parado há dias tem TODAS as etapas vencidas ao mesmo tempo — cada passada
 *     do cron mandava a próxima, e a cadência inteira saía em minutos. Daí o
 *     INTERVALO entre a etapa anterior e esta ter de ter passado desde o nosso
 *     último envio.
 *  2. Cadência não ressuscita conversa velha: só COMEÇA (etapa 0) se o lead
 *     falou há menos de `maxIdadeParaIniciarMin`. Cadência em andamento segue,
 *     senão a última etapa (24h) nunca aconteceria.
 *
 * A idade da etapa 0 é EFETIVA (04/09/2026): vale o menor entre o silêncio do
 * lead e o tempo desde a abertura do expediente. Sem isso quem escrevia de
 * madrugada nunca recebia nada — às 9h já estava fora da trava.
 */
export function podeDisparar(
  steps: FollowupStep[],
  indice: number,
  ctx: {
    inactivityMin: number;
    /** minutos desde o NOSSO último follow-up; null se nunca mandamos */
    desdeUltimoFollowupMin: number | null;
    maxIdadeParaIniciarMin?: number;
    /**
     * Minutos desde a ABERTURA do expediente; null fora dele ou sem janela.
     * Quem escreveu de madrugada não é lead velho, é lead que chegou fora do
     * horário: sem isto ele nunca entrava na cadência (às 9h já tinha 6h de
     * silêncio e a trava de idade barrava). Eram 4 numa noite só.
     */
    minutosDesdeAberturaMin?: number | null;
    /**
     * O lead respondeu ao nosso último follow-up? Aí ele NÃO está silencioso, e
     * a barra sobe pra `MIN_SILENCIO_APOS_RESPOSTA_MIN` — ver o comentário da
     * constante (o caso do Marcos, cobrado 6 min depois de dizer que estava no
     * trabalho).
     */
    respondeuAoUltimoFollowup?: boolean;
  },
): boolean {
  const step = steps[indice];
  if (!step) return false;

  // ⏰ O RELOGIO DA CADENCIA CONTA TEMPO DE EXPEDIENTE, nao tempo de parede.
  //
  // 🐛 09/09/2026 — o Darlei viu a cadencia disparando as 9h em cima de lead da
  // noite. O bot responde 24h, a cadencia so no expediente. Entao lead que
  // escreveu 01h40, foi respondido 01h41 e dormiu chegava as 09h00 com SETE
  // HORAS de silencio: as etapas de 5 e 10 minutos estavam as duas vencidas, e
  // o unico freio era o espacamento entre etapas consecutivas (5 min). Ele
  // levava DOIS toques de robo em 5 minutos, logo de manha, sobre uma conversa
  // da madrugada. Aconteceu com tres leads hoje: 09:00+09:05, 09:01+09:05,
  // 09:01+09:07.
  //
  // Contando desde a ABERTURA da janela, as 09h00 a espera efetiva e zero: o
  // primeiro toque sai 09h05 e o segundo 09h10, que e a cadencia que o Darlei
  // configurou. `minutosDesdeAberturaMin` ja existia, mas so limitava a trava
  // de IDADE da etapa 0 — nao entrava na comparacao com `after_minutes`.
  const desdeAbertura = ctx.minutosDesdeAberturaMin;
  const esperaEfetivaMin =
    desdeAbertura == null ? ctx.inactivityMin : Math.min(ctx.inactivityMin, desdeAbertura);

  if (esperaEfetivaMin < step.after_minutes) return false;

  // Quem respondeu está conversando, não sumido: espera uma hora antes de
  // cobrar de novo, em vez dos 5 minutos da etapa 1.
  if (ctx.respondeuAoUltimoFollowup && ctx.inactivityMin < MIN_SILENCIO_APOS_RESPOSTA_MIN) {
    return false;
  }

  const maxIdade = ctx.maxIdadeParaIniciarMin ?? MAX_IDADE_PARA_INICIAR_MIN;
  if (indice === 0) {
    return esperaEfetivaMin <= maxIdade;
  }

  if (ctx.desdeUltimoFollowupMin == null) return true;
  const anterior = steps[indice - 1]!;
  const intervaloMin = Math.max(step.after_minutes - anterior.after_minutes, 0);
  return ctx.desdeUltimoFollowupMin >= intervaloMin;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function firstName(displayName: string | null): string {
  const n = (displayName ?? "").trim().split(/\s+/)[0] ?? "";
  return n.length >= 2 ? n : "tudo bem";
}

/** Move o lead do contato pra etapa "perdido" (descarte por inatividade). */
async function discardLead(
  admin: SupabaseClient,
  orgId: string,
  contactId: string,
): Promise<void> {
  const { data: lead } = await admin
    .from("crm_leads")
    .select("id, pipeline_id, status")
    .eq("organization_id", orgId)
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!lead || (lead as { status: string }).status !== "open") return;

  const pipelineId = (lead as { pipeline_id: string }).pipeline_id;
  const { data: lostStage } = await admin
    .from("crm_stages")
    .select("id")
    .eq("organization_id", orgId)
    .eq("pipeline_id", pipelineId)
    .eq("is_lost", true)
    .eq("is_archived", false)
    .order("position", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!lostStage) return;

  await admin
    .from("crm_leads")
    .update({
      stage_id: (lostStage as { id: string }).id,
      status: "lost",
      lost_reason: "Inatividade (cadência de reengajamento)",
      closed_at: new Date().toISOString(),
    })
    .eq("id", (lead as { id: string }).id)
    .eq("organization_id", orgId);
}

async function sweepOrg(
  admin: SupabaseClient,
  settings: FollowupSettings,
  now: number,
  summary: FollowupSweepSummary,
): Promise<void> {
  const orgId = settings.organization_id;
  const steps = settings.steps;
  if (!Array.isArray(steps) || steps.length === 0) return;
  if (!inBusinessHours(settings.business_hours, new Date(now))) return; // fora do expediente
  // Quanto faz que o expediente abriu — entra na trava de idade da etapa 0.
  const desdeAberturaMin = minutosDesdeAberturaDaJanela(settings.business_hours, new Date(now));

  // ⚠️ SÓ LEAD NOVO (decisão do Darlei, 03/09/2026). A cadência vale apenas pra
  // conversa criada DEPOIS da ativação. Sem isto, ligar o reengajamento varre o
  // acervo: em 03/09 foram 116 mensagens pra 34 conversas paradas em 5 minutos,
  // porque conversa antiga já cruzou o prazo de todas as etapas.
  // Sem enabled_at (tenant legado) o worker NÃO varre nada de propósito: melhor
  // exigir que o gestor ative de novo, marcando o corte, que mandar em massa.
  if (!settings.enabled_at) {
    logger.warn("[followup] sem enabled_at, pulando org", { organization_id: orgId });
    return;
  }

  const { data: rows } = await admin
    .from("conversations")
    .select(
      "id, created_at, contact_id, status, last_inbound_at, last_outbound_at, last_followup_at, followup_step, bot_silenced_until, assigned_to_user_id, contacts:contact_id(display_name, is_blocked, force_human, is_internal)",
    )
    .eq("organization_id", orgId)
    .in("status", ["open", "ai_handling"])
    .not("last_inbound_at", "is", null);

  for (const conv of (rows ?? []) as unknown as ConvRow[]) {
    // Conversa que já existia quando o reengajamento foi ativado nunca entra.
    if (!conversaElegivelPorAtivacao(conv.created_at, settings.enabled_at)) continue;

    // 🐛 07-08/09/2026 — O BOT MORREU (o provider passou a exigir um header) e a
    // cadencia seguiu rodando: 332 mensagens em 50 conversas cobrando lead que
    // NUNCA recebeu resposta. "Oi, ainda ta por ai?" pra quem escreveu e ficou
    // no vacuo e ofensivo, e nao e reengajamento: a gente deve a resposta.
    //
    // A bola tem de estar com o LEAD — e quem conta e a ULTIMA RESPOSTA DE
    // VERDADE, nunca `last_outbound_at`.
    //
    // 🐛 09/09/2026 — o furo da trava de ontem: a cadencia envia pelo
    // sendMessageHandler, que atualiza `last_outbound_at`. O primeiro toque
    // mexia no proprio relogio que a trava consultava, e do segundo em diante
    // ela sempre passava. Resultado medido: 19 leads escreveram, NUNCA
    // receberam resposta nenhuma, e levaram 141 toques (o Waldeir levou 25);
    // cinco deles as 9h de hoje, na abertura do expediente.
    //
    // Sem resposta nenhuma na conversa, a cadencia seria a UNICA coisa falando
    // com o lead. Isso nao e reengajamento, e um robo insistindo com quem ainda
    // espera a primeira palavra — e serve de rede pra qualquer falha futura do
    // agente, sem precisar saber a causa.
    const { data: ultimas } = await admin
      .from("messages")
      .select("direction, body, sent_via, sent_at, metadata")
      .eq("organization_id", orgId)
      .eq("conversation_id", conv.id)
      .order("sent_at", { ascending: false })
      .limit(15);
    type MsgLinha = {
      direction: string;
      body: string | null;
      sent_via: string | null;
      sent_at: string;
      metadata: Record<string, unknown> | null;
    };
    const historico = (ultimas ?? []) as MsgLinha[];
    const respostaDeVerdade = historico.find(
      (m) => m.direction === "outbound" && !ehMensagemDaCadencia(m.body, m.metadata, steps),
    );
    if (
      !respostaDeVerdade ||
      new Date(respostaDeVerdade.sent_at).getTime() < new Date(conv.last_inbound_at!).getTime()
    ) {
      continue;
    }

    // O lead RECUSOU → a cadencia para PRA SEMPRE nesta conversa.
    //
    // Pedido do Darlei (09/09/2026) olhando o Ronaldo Costa: as 09h07 ele
    // respondeu "Bom dia, nao obrigado" a oferta de simulacao, o bot se
    // despediu bem, e as 09h13 a cadencia perguntou "Oi, ainda ta por ai?".
    //
    // Zerar a etapa nao bastaria: a proxima passada recomecaria do zero. Manda
    // `followup_step` pro fim da fila, que e o mesmo estado de quem esgotou a
    // cadencia. O bot NAO e silenciado: se o lead voltar com uma pergunta, ele
    // responde — o que para e a insistencia por tempo, nao o atendimento.
    const ultimaDoLead = historico.find((m) => m.direction === "inbound");
    const ultimaNossa = historico.find((m) => m.direction === "outbound");
    if (
      ultimaDoLead &&
      leadRecusou(ultimaDoLead.body, {
        respondendoACadencia: Boolean(
          ultimaNossa &&
            ehMensagemDaCadencia(ultimaNossa.body, ultimaNossa.metadata, steps) &&
            new Date(ultimaNossa.sent_at).getTime() < new Date(ultimaDoLead.sent_at).getTime(),
        ),
      })
    ) {
      await admin
        .from("conversations")
        .update({ followup_step: steps.length })
        .eq("id", conv.id)
        .eq("organization_id", orgId);
      await admin.rpc("emit_event" as never, {
        p_event_type: "followup.recusado",
        p_entity_kind: "conversation",
        p_entity_id: conv.id,
        p_payload: { conversation_id: conv.id, fala_do_lead: (ultimaDoLead.body ?? "").slice(0, 200) },
        p_metadata: { source: "inactivity-followup" },
        p_organization_id: orgId,
      } as never);
      summary.recusados += 1;
      continue;
    }
    if (!conv.contacts || conv.contacts.is_blocked || conv.contacts.force_human) continue;
    if (conv.contacts.is_internal) continue; // corretor não recebe cadência de lead
    // Transferida pra humano (silenciada) → cadência não roda.
    // ⚠️ O handoff grava bot_silenced_until='infinity' (EPIC-06/IA-06). O
    // PostgREST serializa timestamptz 'infinity' como a STRING "infinity", que
    // new Date() parseia como NaN — e `NaN > now` é false, então o check antigo
    // NÃO pegava o handoff e o follow-up cutucava conversa já entregue a humano.
    // Mesmo tratamento explícito que o dispatcher já faz (dispatcher/index.ts:226).
    const silencedUntil = conv.bot_silenced_until;
    if (
      silencedUntil &&
      (silencedUntil === "infinity" || new Date(silencedUntil).getTime() > now)
    ) {
      continue;
    }

    // Corretor já foi avisado → cadência PARA. Decisão do Darlei (03/09/2026):
    // o aviso sai no WhatsApp pessoal do corretor e ele continua o atendimento
    // do próprio número, então de nada serve o sistema seguir cutucando o lead.
    // A atribuição é exatamente o que dispara a notificação (lib/attendance/
    // assign.ts), por isso ela é o sinal. Lead atribuído e esquecido não fica
    // órfão: quem cobra é o SLA (lib/attendance/sla.ts), que reescala e, no teto
    // de passes, chama o gestor. Não é papel do reengajamento.
    if (conv.assigned_to_user_id) continue;

    const lastInbound = new Date(conv.last_inbound_at!).getTime();

    // Humano já respondeu depois da última mensagem do lead → NÃO cutucar.
    // Foi a causa do incidente 01/09: `bot_silenced_until` só é preenchido pela
    // tool de handoff do bot, então corretor que atende direto (pelo celular ou
    // pelo composer, sem o bot passar o bastão) não silenciava a cadência, e o
    // lead levava ping durante a negociação. Agora que o eco do WAHA é
    // descartado no ingest, `user`/`external_device` significam humano DE VERDADE,
    // então esta checagem é confiável. `sent_via='ai'` fica de fora de propósito
    // (é o próprio bot/follow-up, não conta como atendimento humano).
    const { data: humanReply } = await admin
      .from("messages")
      .select("id")
      .eq("organization_id", orgId)
      .eq("conversation_id", conv.id)
      .eq("direction", "outbound")
      .in("sent_via", ["user", "external_device"])
      .gt("sent_at", conv.last_inbound_at!)
      .limit(1)
      .maybeSingle();
    if (humanReply) continue;

    // Lead respondeu depois do nosso último follow-up → reseta a cadência.
    if (conv.followup_step > 0 && conv.last_followup_at) {
      if (lastInbound > new Date(conv.last_followup_at).getTime()) {
        await admin
          .from("conversations")
          .update({ followup_step: 0, last_followup_at: null })
          .eq("id", conv.id)
          .eq("organization_id", orgId);
        summary.reset += 1;
        continue;
      }
    }

    if (conv.followup_step >= steps.length) continue;
    const step = steps[conv.followup_step]!;
    const inactivityMin = (now - lastInbound) / 60_000;
    if (inactivityMin < step.after_minutes) continue; // ainda dentro do prazo

    // Trava de idade (não ressuscitar conversa velha) + espaçamento entre etapas.
    // As duas nasceram do incidente de 03/09/2026 — ver podeDisparar().
    const desdeUltimoFollowupMin = conv.last_followup_at
      ? (now - new Date(conv.last_followup_at).getTime()) / 60_000
      : null;
    if (
      !podeDisparar(steps, conv.followup_step, {
        inactivityMin,
        desdeUltimoFollowupMin,
        minutosDesdeAberturaMin: desdeAberturaMin,
        respondeuAoUltimoFollowup: respondeuAoUltimoFollowup(
          conv.last_inbound_at,
          conv.last_followup_at,
        ),
      })
    )
      continue;

    // ⚠️ RESERVA A ETAPA ANTES DE ENVIAR (mesmo incidente: a Norma recebeu a
    // MESMA frase 3x em 35s). Antes o código enviava e só depois avançava, então
    // duas passadas concorrentes do cron liam o mesmo followup_step e as duas
    // enviavam. O update condicional em followup_step é a reserva: quem não
    // atualizar nenhuma linha perdeu a corrida e não envia.
    const { data: reservou } = await admin
      .from("conversations")
      .update({
        followup_step: conv.followup_step + 1,
        last_followup_at: new Date(now).toISOString(),
        ...(step.discard ? { status: "resolved", status_changed_at: new Date(now).toISOString() } : {}),
      })
      .eq("id", conv.id)
      .eq("organization_id", orgId)
      .eq("followup_step", conv.followup_step)
      .select("id");
    if (!reservou || reservou.length === 0) continue; // outra passada já pegou

    // Envia a mensagem da etapa (persiste + WAHA via sendMessageHandler).
    const body = step.message.replace(/\{nome\}/g, firstName(conv.contacts.display_name));
    try {
      await sendMessageHandler(
        admin,
        {
          organization_id: orgId,
          actor: { type: "ai_agent", id: "followup-worker", role: "agent" },
          requestId: randomUUID(),
        },
        {
          conversation_id: conv.id,
          type: "text",
          body,
          // MARCA: e o que permite a passada seguinte saber que esta fala foi da
          // cadencia e nao resposta de ninguem (ver ehMensagemDaCadencia).
          metadata: { followup_step: conv.followup_step + 1 },
        },
      );
    } catch (err) {
      summary.errors.push(`${conv.id}: send ${err instanceof Error ? err.message : String(err)}`);
      // Devolve a etapa: com a reserva feita antes do envio, falhar aqui sem
      // desfazer pularia a etapa pra sempre. Preferimos tentar de novo na
      // próxima passada a perder o toque — e mandar 2x é pior que mandar tarde,
      // por isso a reserva vem antes mesmo assim.
      await admin
        .from("conversations")
        .update({ followup_step: conv.followup_step, last_followup_at: conv.last_followup_at })
        .eq("id", conv.id)
        .eq("organization_id", orgId);
      continue;
    }

    await admin.rpc("emit_event" as never, {
      p_event_type: "followup.sent",
      p_entity_kind: "conversation",
      p_entity_id: conv.id,
      p_payload: { conversation_id: conv.id, step: conv.followup_step + 1, discard: !!step.discard },
      p_metadata: { source: "inactivity-followup" },
      p_organization_id: orgId,
    } as never);

    if (step.discard && conv.contact_id) {
      await discardLead(admin, orgId, conv.contact_id);
      summary.discarded += 1;
    }
    summary.sent += 1;

    if (settings.throttle_seconds > 0) await sleep(settings.throttle_seconds * 1000);
  }
}

export async function sweepFollowups(
  admin: SupabaseClient,
  opts: { now?: Date } = {},
): Promise<FollowupSweepSummary> {
  const summary: FollowupSweepSummary = {
    orgs_scanned: 0,
    sent: 0,
    discarded: 0,
    reset: 0,
    recusados: 0,
    errors: [],
  };
  const now = (opts.now ?? new Date()).getTime();

  const { data: enabledOrgs, error } = await admin
    .from("followup_settings")
    .select("organization_id, enabled, throttle_seconds, business_hours, steps, enabled_at")
    .eq("enabled", true);
  if (error) {
    summary.errors.push(`load_settings: ${error.message}`);
    return summary;
  }

  for (const s of (enabledOrgs ?? []) as unknown as FollowupSettings[]) {
    if (!s.enabled) continue;
    summary.orgs_scanned += 1;
    try {
      await sweepOrg(admin, s, now, summary);
    } catch (err) {
      summary.errors.push(`${s.organization_id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return summary;
}
