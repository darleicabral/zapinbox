# syntax=docker/dockerfile:1
# DeskcommCRM — imagem de produção self-host (Next.js standalone).
# Build: docker build --build-arg NEXT_PUBLIC_SUPABASE_URL=... -t deskcomm-app .

# ---- deps: instala dependências (layer cacheável) ----
FROM node:20-alpine AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ---- build: gera .next/standalone ----
FROM node:20-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Vars públicas (NEXT_PUBLIC_*) são embutidas no bundle CLIENT em build-time.
# Trocar qualquer uma exige REBUILD da imagem. Segredos de runtime NUNCA entram
# aqui (a guarda de fase em lib/env.ts permite o build sem eles).
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_ADMIN_URL
# O build do Next (webpack + Sentry) é faminto: o heap default do Node (~2GB)
# estoura. NODE_OPTIONS eleva pra 4GB → requer VPS com >=4GB RAM (ou swap).
# O install.sh checa RAM/swap antes de buildar.
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_PUBLIC_ADMIN_URL=$NEXT_PUBLIC_ADMIN_URL \
    NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    NODE_OPTIONS=--max-old-space-size=4096

# Turbopack (`pnpm build`): ~4min vs ~34min do webpack num VPS. O bloco `webpack:`
# do Sentry (tree-shake + upload de sourcemap em build-time) é ignorado, mas o
# Sentry RUNTIME segue ativo (DSN hardcoded nas configs). Sourcemap upload é
# concern só da Vercel; aqui o ganho de tempo de build é o que importa pro leigo.
RUN pnpm build

# ---- runner: imagem slim de produção ----
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1
# non-root
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001
# O output standalone NÃO inclui public/ nem .next/static — copiar explicitamente,
# senão CSS/JS/assets retornam 404 (app "sem estilo").
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public
USER nextjs
EXPOSE 3000
# server.js é o entrypoint gerado pelo output standalone.
CMD ["node", "server.js"]
