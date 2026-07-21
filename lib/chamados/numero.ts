/**
 * Gerador do nº do chamado (tenant Itaville): `VG-2026-001` — sequência por
 * empreendimento + ano, gravada em `crm_leads.external_id`.
 *
 * Genérico o suficiente p/ não quebrar outros tenants: só gera quando o
 * empreendimento casa com um prefixo conhecido (abaixo). Qualquer lead sem
 * empreendimento mapeado fica com external_id null (comportamento atual).
 *
 * Concorrência: o índice único parcial `uniq_crm_leads_org_source_external`
 * (organization_id, source, external_id) garante unicidade; o handler tenta
 * inserir e, em caso de colisão (23505), recalcula e repete. Volume real é
 * baixo (1 operadora), então a corrida é praticamente inexistente.
 */

export const EMPREENDIMENTO_PREFIX: Record<string, string> = {
  "Van Gogh": "VG",
  "Salvador Dalí": "SD",
  "Jardim Canaã": "JC",
};

/** Prefixo do chamado p/ um empreendimento, ou null se não mapeado. */
export function chamadoPrefix(empreendimento: unknown): string | null {
  if (typeof empreendimento !== "string") return null;
  return EMPREENDIMENTO_PREFIX[empreendimento] ?? null;
}

/** Monta o nº: prefixo + ano + seq com 3 dígitos (VG-2026-007). */
export function formatChamado(prefix: string, year: number, seq: number): string {
  return `${prefix}-${year}-${String(seq).padStart(3, "0")}`;
}

/** Extrai o seq numérico de um external_id (0 se não casar o padrão prefixo-ano-N). */
export function parseSeq(externalId: string | null, prefix: string, year: number): number {
  if (!externalId) return 0;
  const m = externalId.match(new RegExp(`^${prefix}-${year}-(\\d+)$`));
  return m ? parseInt(m[1]!, 10) : 0;
}

/** Padrão SQL LIKE p/ buscar os external_ids já usados (prefixo-ano-%). */
export function chamadoLikePattern(prefix: string, year: number): string {
  return `${prefix}-${year}-%`;
}

/** Próximo seq (max+1) a partir dos external_ids já usados — robusto a padding. */
export function nextSeq(externalIds: Array<string | null>, prefix: string, year: number): number {
  let max = 0;
  for (const id of externalIds) {
    const seq = parseSeq(id, prefix, year);
    if (seq > max) max = seq;
  }
  return max + 1;
}

/** Erro de violação de unicidade do Postgres no external_id (p/ retry). */
export function isExternalIdConflict(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; message?: string };
  return e.code === "23505" && /external/i.test(e.message ?? "");
}
