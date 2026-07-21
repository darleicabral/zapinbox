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
