/**
 * Freio de mão do número de WhatsApp: teto de envio por minuto e por hora.
 *
 * 🚨 O RISCO É PERDER O NÚMERO. O WhatsApp que a Avant usa não é o canal
 * oficial da Meta — é uma sessão WAHA num número comum. Rajada de mensagem para
 * muitos destinatários diferentes é exatamente o padrão que o WhatsApp lê como
 * spam, e a punição é o banimento do número, não um erro de API. Perder o número
 * é perder o histórico de todas as conversas e o contato de todos os leads.
 *
 * Medido no banco em 09/09/2026, desde 01/09:
 *   - pior rajada: **51 mensagens em 1 minuto** (03/09 14h00, o incidente do
 *     acervo), 187 em 5 minutos, 276 em uma hora;
 *   - dia normal: 150 a 280 mensagens, com pico de 33 numa hora;
 *   - as 29 cobranças que o Cléber reclamou saíram em ~3 minutos.
 *
 * ⚠️ ESTE FREIO FICA NO `sendWAHA`, DE PROPÓSITO. É o único ponto por onde tudo
 * sai: resposta do bot, cadência, aviso de lead novo, cobrança, resgate. Cada
 * um desses já teve um bug de rajada esta semana — bot, cadência e cobrança. Uma
 * proteção que dependesse de cada função lembrar de se comportar não protege
 * nada, porque o próximo recurso vai esquecer.
 *
 * Quando o teto da HORA estoura, o envio PARA e o gestor é avisado. Silêncio com
 * alarme é ruim; número banido é irreversível.
 */
import { Redis } from "@upstash/redis";

import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

/**
 * Teto por minuto. O dia mais movimentado teve 33 mensagens na hora de pico,
 * ~0,5/min de média, então 12 é folga larga pra operação real e ainda corta a
 * rajada de 51 pela raiz.
 */
export const TETO_POR_MINUTO = 12;
/**
 * Teto por hora. O pior caso legítimo medido foi 33; 150 dá espaço pra um dia
 * atípico (distribuição de fila, por exemplo) e ainda assim é metade da rajada
 * de 276 que já aconteceu.
 */
export const TETO_POR_HORA = 150;

export interface DecisaoDeEnvio {
  liberado: boolean;
  motivo: "ok" | "minuto" | "hora";
  noMinuto: number;
  naHora: number;
}

let _redis: Redis | null = null;
let _avisouFallback = false;

function redis(): Redis | null {
  if (_redis) return _redis;
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    if (!_avisouFallback) {
      logger.warn(
        "[waha.limite] Redis ausente — contagem em memória, que NÃO protege entre instâncias",
      );
      _avisouFallback = true;
    }
    return null;
  }
  _redis = new Redis({ url, token });
  return _redis;
}

interface Balde {
  n: number;
  expiraEm: number;
}
const _memoria = new Map<string, Balde>();

function contarNaMemoria(chave: string, janelaSeg: number): number {
  const agora = Date.now();
  const atual = _memoria.get(chave);
  if (!atual || atual.expiraEm <= agora) {
    _memoria.set(chave, { n: 1, expiraEm: agora + janelaSeg * 1000 });
    return 1;
  }
  atual.n += 1;
  return atual.n;
}

async function contar(chave: string, janelaSeg: number): Promise<number> {
  const r = redis();
  if (!r) return contarNaMemoria(chave, janelaSeg);
  try {
    const n = await r.incr(chave);
    if (n === 1) await r.expire(chave, janelaSeg);
    return n;
  } catch (err) {
    logger.warn("[waha.limite] Redis falhou, caindo pra memória", {
      error: err instanceof Error ? err.message : String(err),
    });
    return contarNaMemoria(chave, janelaSeg);
  }
}

/**
 * Decide se pode enviar AGORA, e conta o envio. Janela fixa por sessão do WAHA,
 * porque a sessão é o número — e é o número que leva o banimento, não o tenant.
 *
 * Conta antes de mandar (e não depois) de propósito: numa rajada, contar depois
 * deixa passar a rajada inteira antes do primeiro bloqueio.
 */
export async function podeEnviarAgora(
  sessionName: string,
  agora: Date = new Date(),
): Promise<DecisaoDeEnvio> {
  const minuto = Math.floor(agora.getTime() / 60_000);
  const hora = Math.floor(agora.getTime() / 3_600_000);
  const noMinuto = await contar(`waha-envio:${sessionName}:m:${minuto}`, 120);
  const naHora = await contar(`waha-envio:${sessionName}:h:${hora}`, 7200);

  if (naHora > TETO_POR_HORA) {
    return { liberado: false, motivo: "hora", noMinuto, naHora };
  }
  if (noMinuto > TETO_POR_MINUTO) {
    return { liberado: false, motivo: "minuto", noMinuto, naHora };
  }
  return { liberado: true, motivo: "ok", noMinuto, naHora };
}

/** O texto do alarme, separado pra ser testável. */
export function textoDoAlarmeDeTeto(d: DecisaoDeEnvio): string {
  if (d.motivo === "hora") {
    return (
      `🛑 *Envio de WhatsApp PARADO por segurança.*\n\n` +
      `Passamos de ${TETO_POR_HORA} mensagens em uma hora (${d.naHora}). O envio está ` +
      `bloqueado até a hora virar.\n\n` +
      `Rajada é o padrão que o WhatsApp lê como spam, e a punição é banir o número. ` +
      `Alguma automação está disparando em massa — vale olhar agora.`
    );
  }
  return (
    `⚠️ *Rajada de envio contida.*\n\n` +
    `Passamos de ${TETO_POR_MINUTO} mensagens em um minuto (${d.noMinuto}). ` +
    `As mensagens seguintes desse minuto foram descartadas pra proteger o número.`
  );
}
