/**
 * Paths that bypass auth check in middleware.
 * Match precedence: array order. First match wins.
 */
export const PUBLIC_PATHS: RegExp[] = [
  /^\/$/,
  /^\/login(\/.*)?$/,
  /^\/403$/,
  /^\/admin\/forbidden$/,
  /^\/404$/,
  /^\/500$/,
  /^\/503$/,
  /^\/api\/v1\/health$/,
  /^\/api\/v1\/webhooks\//,
  /^\/api\/v1\/cron\//,
  // Dashboard da Diretoria (Itaville): rota pública de agregados, auth por token
  // dentro do próprio handler (ver app/api/v1/public/itaville-dashboard/route.ts).
  /^\/api\/v1\/public\//,
  /^\/api\/internal\//,
  /^\/api\/mcp(\/.*)?$/,
  /^\/_next\//,
  /^\/favicon\.ico$/,
  /^\/team\/accept-invite\/.+$/,
  /^\/account-suspended$/,
  // Prévia de design (dev): a página faz notFound() em produção, então liberar
  // o path é seguro — 404 em prod de qualquer forma.
  /^\/dev\//,
  // PWA: precisam ser públicos (o install falha se o manifest cair no login).
  // `.webmanifest` e `.html` não estão na exclusão de extensões do matcher.
  /^\/manifest\.webmanifest$/,
  /^\/sw\.js$/,
  /^\/offline\.html$/,
];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((re) => re.test(pathname));
}
