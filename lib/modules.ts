/**
 * Módulos opcionais por-org (flag de piloto).
 *
 * Hoje só o "painel de pós-venda / crise" da Itaville. É intencionalmente uma
 * lista de org ids aqui (e não uma coluna no banco) enquanto é piloto de 1 tenant;
 * quando o pós-venda virar produto revendável p/ construtoras, trocar por uma
 * feature-flag/coluna na organization e ler de lá.
 */
const POSVENDA_ORG_IDS = new Set<string>([
  "bd014ed4-f62f-42f3-b092-3182cef3ef0b", // Itaville
]);

export function hasPosvendaModule(orgId: string | null | undefined): boolean {
  return !!orgId && POSVENDA_ORG_IDS.has(orgId);
}

/**
 * Manual de atendimento (Google Doc) embedado na página /app/manual — consulta
 * rápida p/ o operador durante o atendimento. Mesmo padrão de piloto por org id;
 * vira coluna/setting quando o pós-venda for produto. Guardamos só o ID do doc;
 * a URL de embed (/preview) e a de abrir (/edit) são derivadas na página.
 */
const POSVENDA_MANUAL_DOC_IDS: Record<string, string> = {
  // Itaville — manual de atendimento pós-venda
  "bd014ed4-f62f-42f3-b092-3182cef3ef0b": "16w5TLU3BOrNf5MsY48zVepVSfhDNt9ExX5_QuaaBOFw",
};

export function posvendaManualDocId(orgId: string | null | undefined): string | null {
  return (orgId && POSVENDA_MANUAL_DOC_IDS[orgId]) || null;
}
