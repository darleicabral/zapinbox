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
  /^\/api\/internal\//,
  /^\/api\/mcp(\/.*)?$/,
  /^\/_next\//,
  /^\/favicon\.ico$/,
  /^\/team\/accept-invite\/.+$/,
  /^\/account-suspended$/,
  // PWA: precisam ser públicos (o install falha se o manifest cair no login).
  // `.webmanifest` e `.html` não estão na exclusão de extensões do matcher.
  /^\/manifest\.webmanifest$/,
  /^\/sw\.js$/,
  /^\/offline\.html$/,
];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((re) => re.test(pathname));
}
