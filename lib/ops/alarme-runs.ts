/**
 * O alarme que faltava: avisar quando o bot para de funcionar.
 *
 * 🚨 06–08/09/2026 — o bot da Avant ficou DOIS DIAS INTEIROS sem responder.
 * O provider passou a exigir um header (`x-opencode-session`) e todas as 156
 * execuções voltaram HTTP 400. Ninguém foi avisado. O sintoma chegou ao Darlei
 * de forma indireta e enganosa — "a IA está deixando de mandar leads pro
 * corretor" — e a taxa de encaminhamento tinha caído de 57% pra ZERO.
 *
 * Duas formas de morrer, e o alarme pega as duas, porque elas não se parecem:
 *
 *  1. FALHA — as execuções acontecem e quebram. Foi o apagão do provider, e
 *     agora também pega contato bloqueado por engano e sessão do WhatsApp
 *     caída, desde que execução que gera resposta e não entrega nada passou a
 *     ser registrada como falha (09/09).
 *
 *  2. SILÊNCIO — mensagem de lead entra e execução nenhuma nasce. Aqui a taxa
 *     de falha é 0% e um alarme que só olhasse falha veria tudo verde. É o
 *     retrato de dispatcher parado, cron morto ou fila travada.
 *
 * O alarme fala SÓ com o admin do tenant. É o único aviso do sistema que vai pro
 * dono de propósito: a regra "nunca encaminhe para o dono" é sobre LEAD, e
 * supervisionar é justamente o papel dele. Corretor e gerente ficam fora — ver
 * a nota em avisarOAdmin().
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { inBusinessHours } from "@/lib/attendance/rotation";
import { logger } from "@/lib/logger";
import { resolveChatIdChecked, sendWAHA } from "@/lib/waha/send";

/** Janela de observação. Uma hora dá amostra sem esconder o problema. */
export const JANELA_MIN = 60;
/** Abaixo disso a amostra é pequena e uma falha isolada viraria alarme falso. */
export const MINIMO_DE_EXECUCOES = 4;
/** Acima disso não é azar, é defeito. */
export const LIMITE_DE_FALHA_PCT = 30;
/** Mensagem de lead sem execução nenhuma: dispatcher parado. */
export const MINIMO_DE_ENTRADAS_SEM_RUN = 3;
/** Não repetir o mesmo alarme antes disso — alarme repetido vira ruído. */
export const SILENCIO_ENTRE_ALARMES_H = 3;

export type MotivoDoAlarme = "falha" | "silencio";

export interface Diagnostico {
  alarmar: boolean;
  motivo: MotivoDoAlarme | null;
  runs: number;
  falhas: number;
  pctFalha: number;
  entradas: number;
  texto: string | null;
}

export interface AlarmeSummary {
  orgs_scanned: number;
  alarmes: number;
  detalhes: string[];
  errors: string[];
}

/**
 * A decisão, separada do banco pra ser testável. Recebe o que foi contado na
 * janela e devolve se alarma, por quê, e o texto que o gestor vai ler.
 */
export function diagnosticar(contagem: {
  runs: number;
  falhas: number;
  entradas: number;
}): Diagnostico {
  const { runs, falhas, entradas } = contagem;
  const pctFalha = runs > 0 ? Math.round((falhas / runs) * 100) : 0;
  const base: Omit<Diagnostico, "alarmar" | "motivo" | "texto"> = {
    runs,
    falhas,
    pctFalha,
    entradas,
  };

  // 2) SILÊNCIO primeiro: com zero execução, a taxa de falha é 0% e enganaria.
  if (runs === 0 && entradas >= MINIMO_DE_ENTRADAS_SEM_RUN) {
    return {
      ...base,
      alarmar: true,
      motivo: "silencio",
      texto:
        `🚨 *O bot não está atendendo.*\n\n` +
        `Chegaram ${entradas} mensagens de lead na última hora e o agente não rodou NENHUMA vez. ` +
        `Isso é dispatcher parado ou fila travada — não é falta de movimento.\n\n` +
        `Os leads estão escrevendo e ninguém está respondendo.`,
    };
  }

  // 1) FALHA: execuções acontecendo e quebrando.
  if (runs >= MINIMO_DE_EXECUCOES && pctFalha >= LIMITE_DE_FALHA_PCT) {
    return {
      ...base,
      alarmar: true,
      motivo: "falha",
      texto:
        `🚨 *O bot está falhando.*\n\n` +
        `${falhas} de ${runs} execuções deram erro na última hora (${pctFalha}%).\n\n` +
        `Em 07 e 08/09 isso ficou dois dias sem ninguém ver: o provider de IA passou a exigir ` +
        `um header novo e o bot emudeceu. Vale olhar o erro das execuções agora.`,
    };
  }

  return { ...base, alarmar: false, motivo: null, texto: null };
}

/**
 * A execucao terminou sem responder o lead?
 *
 * `failed` e o caso obvio. `aborted` conta tambem, e foi um furo descoberto em
 * 10/09/2026: duas execucoes morreram com `token_budget_exceeded` e o alarme
 * nao viu nada, porque so olhava `failed`. Do ponto de vista do lead nao ha
 * diferenca — ninguem respondeu.
 *
 * `skipped` fica FORA de proposito: e a decisao deliberada de nao responder
 * (conversa ocupada, bot silenciado, contato interno), e isso e o sistema
 * funcionando.
 *
 * Abort antigo do tipo `stale_inflight` (o reaper limpando run orfao) nao
 * poluiu porque a janela filtra por `created_at` do run, e run velho fica fora.
 */
function ehNaoResposta(r: { status: string; abort_reason: string | null }): boolean {
  return r.status === "failed" || r.status === "aborted";
}

/** Varre os tenants com atendimento ligado e alarma quem estiver quebrado. */
export async function varrerAlarmes(
  admin: SupabaseClient,
  opts: { now?: Date } = {},
): Promise<AlarmeSummary> {
  const agora = opts.now ?? new Date();
  const resumo: AlarmeSummary = { orgs_scanned: 0, alarmes: 0, detalhes: [], errors: [] };
  const desde = new Date(agora.getTime() - JANELA_MIN * 60_000).toISOString();

  const { data: orgs, error } = await admin
    .from("attendance_settings")
    .select("organization_id, business_hours")
    .eq("enabled", true);
  if (error) {
    resumo.errors.push(`load_orgs: ${error.message}`);
    return resumo;
  }

  for (const row of (orgs ?? []) as {
    organization_id: string;
    business_hours: Parameters<typeof inBusinessHours>[0];
  }[]) {
    const orgId = row.organization_id;

    // Fora do expediente o alarme fica calado.
    //
    // Não é preguiça: o gestor não conserta provider às 3h da manhã, e alarme
    // que acorda de madrugada é alarme que vira silenciado. O apagão de 06-08/09
    // começou às 21h — com esta regra ele teria sido avisado às 9h do dia
    // seguinte, em vez de descobrir dois dias depois por um print de lead sem
    // resposta. A madrugada também tem pouca amostra, então o critério de
    // volume mínimo raramente fecharia lá de qualquer forma.
    if (!inBusinessHours(row.business_hours, agora)) continue;

    resumo.orgs_scanned += 1;
    try {
      const { data: runs } = await admin
        .from("ai_agent_runs")
        .select("status, abort_reason")
        .eq("organization_id", orgId)
        .eq("is_dry_run", false)
        .gte("created_at", desde);
      const lista = (runs ?? []) as { status: string; abort_reason: string | null }[];

      const { count: entradas } = await admin
        .from("messages")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId)
        .eq("direction", "inbound")
        .gte("sent_at", desde);

      const d = diagnosticar({
        runs: lista.length,
        falhas: lista.filter((r) => ehNaoResposta(r)).length,
        entradas: entradas ?? 0,
      });
      if (!d.alarmar || !d.texto) continue;

      // Alarme repetido vira ruído, e ruído é ignorado — o oposto do objetivo.
      if (await alarmouRecentemente(admin, orgId, d.motivo!, agora)) continue;

      const enviados = await avisarOAdmin(admin, orgId, d.texto);
      await registrar(admin, orgId, d, enviados);
      if (enviados > 0) {
        resumo.alarmes += 1;
        resumo.detalhes.push(`${orgId}: ${d.motivo} (${d.falhas}/${d.runs}, ${d.entradas} entradas)`);
      } else {
        resumo.errors.push(`${orgId}: alarme ${d.motivo} sem destinatario com telefone`);
      }
    } catch (err) {
      resumo.errors.push(`${orgId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return resumo;
}

async function alarmouRecentemente(
  admin: SupabaseClient,
  organizationId: string,
  motivo: MotivoDoAlarme,
  agora: Date,
): Promise<boolean> {
  const desde = new Date(agora.getTime() - SILENCIO_ENTRE_ALARMES_H * 3_600_000).toISOString();
  const { count } = await admin
    .from("event_log")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("event_type", "ops.alarme_enviado")
    .eq("payload->>motivo", motivo)
    .gte("created_at", desde);
  return (count ?? 0) > 0;
}

async function registrar(
  admin: SupabaseClient,
  organizationId: string,
  d: Diagnostico,
  enviados: number,
): Promise<void> {
  try {
    await admin.rpc("emit_event" as never, {
      p_event_type: "ops.alarme_enviado",
      p_entity_kind: "organization",
      p_entity_id: organizationId,
      p_payload: {
        motivo: d.motivo,
        runs: d.runs,
        falhas: d.falhas,
        pct_falha: d.pctFalha,
        entradas: d.entradas,
        destinatarios: enviados,
      },
      p_metadata: { source: "alarme-runs" },
      p_organization_id: organizationId,
    } as never);
  } catch {
    // Best-effort. Sem registro o alarme pode repetir na próxima passada —
    // preferível a engolir um bot morto por causa de um insert que falhou.
  }
}

/**
 * Manda SÓ pro admin do tenant — o gestor que pode agir no sistema.
 *
 * Gerente e corretor ficam FORA de propósito. O Cléber é gerente e atende lead:
 * em 03/09/2026 ele levou 12 alertas do SLA num dia, metade sem ninguém
 * esperando nada, e o Darlei encerrou o assunto com "não precisa alertar". Ele
 * não tem o que fazer com "30% das execuções falharam" — quem mexe no provider
 * e no deploy é o gestor.
 *
 * Testado em produção em 09/09: com admin+gerente saíram DUAS mensagens, e uma
 * delas era exatamente o ruído que a decisão de 03/09 tinha eliminado.
 */
async function avisarOAdmin(
  admin: SupabaseClient,
  organizationId: string,
  texto: string,
): Promise<number> {
  const { data: sessao } = await admin
    .from("channel_sessions")
    .select("waha_session_name")
    .eq("organization_id", organizationId)
    .eq("status", "WORKING")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const sessionName = (sessao as { waha_session_name: string } | null)?.waha_session_name;
  if (!sessionName) return 0;

  const { data: membros } = await admin
    .from("user_organizations")
    .select("user_id, role, notify_whatsapp_e164")
    .eq("organization_id", organizationId)
    .is("revoked_at", null)
    .eq("role", "admin");

  let enviados = 0;
  for (const m of (membros ?? []) as { notify_whatsapp_e164: string | null }[]) {
    if (!m.notify_whatsapp_e164) continue;
    try {
      const chatId = await resolveChatIdChecked({
        sessionName,
        phoneNumber: m.notify_whatsapp_e164,
      });
      if (!chatId) continue;
      const res = await sendWAHA({ sessionName, chatId, text: texto });
      if (res !== null) enviados += 1;
    } catch (err) {
      logger.warn("[ops.alarme] envio falhou", {
        organization_id: organizationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return enviados;
}
