/**
 * Passagem de bastão para a tela de Novo Atendimento.
 *
 * O botão "Abrir atendimento" (lista de Contatos e header do Inbox) manda a
 * atendente pro board com `?novo=1`, e o que já se sabe do cliente (contato,
 * título, sinalização da IA) viaja aqui, no sessionStorage, em vez de virar
 * meia dúzia de parâmetros na URL. É de uso único: o board lê e apaga.
 */

const KEY = "zapinbox:novo-atendimento";

export interface NewLeadHandoffContact {
  id: string;
  display_name: string | null;
  name: string | null;
  phone_number: string | null;
}

export interface NewLeadHandoff {
  contact?: NewLeadHandoffContact | null;
  title?: string;
  description?: string | null;
  /** Pré-preenchimento dos campos custom (canal, empreendimento, triagem da IA). */
  custom_fields?: Record<string, unknown>;
}

export function writeNewLeadHandoff(payload: NewLeadHandoff): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(payload));
  } catch {
    // sessionStorage indisponível (modo restrito): o formulário abre vazio.
  }
}

/**
 * Destino do clique em "Abrir atendimento": o card existente quando o contato
 * é reincidente, senão a tela de Novo Atendimento (deixando a semente pronta).
 */
export function newLeadRouteFor(target: {
  pipeline_id: string;
  lead_id: string | null;
  title?: string;
  description?: string | null;
  prefill?: Record<string, unknown>;
  contact?: NewLeadHandoffContact;
}): string {
  if (target.lead_id) {
    return `/app/pipelines/${target.pipeline_id}?open=${target.lead_id}`;
  }
  writeNewLeadHandoff({
    contact: target.contact ?? null,
    title: target.title ?? "",
    description: target.description ?? null,
    custom_fields: target.prefill ?? {},
  });
  return `/app/pipelines/${target.pipeline_id}?novo=1`;
}

/** Lê e consome (a próxima abertura manual não pode herdar este contato). */
export function takeNewLeadHandoff(): NewLeadHandoff | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    sessionStorage.removeItem(KEY);
    const parsed = JSON.parse(raw) as NewLeadHandoff;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}
