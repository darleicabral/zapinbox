# Guia de Credenciais — DeskcommCRM

> **Pra quem é este doc?** Você acabou de clonar o repo, copiou `.env.example` pra `.env.local`, abriu o arquivo e bateu o desespero: "o que é cada uma dessas chaves e onde eu pego?". Este guia resolve isso. Sem pular etapas, sem assumir que você já configurou nada antes.
>
> **Tempo estimado:** 60-90 minutos pra preencher tudo do zero. Você pode fazer em partes — o app sobe com algumas chaves vazias (veja [Ordem recomendada](#ordem-recomendada)).

---

## Índice

1. [Antes de começar](#antes-de-começar)
2. [Ordem recomendada](#ordem-recomendada)
3. [Supabase](#1-supabase-banco--auth--storage)
4. [Upstash Redis](#2-upstash-redis-rate-limit--idempotência)
5. [WAHA (WhatsApp)](#3-waha-whatsapp)
6. [Anthropic + Vercel AI Gateway](#4-anthropic--vercel-ai-gateway-ia)
7. [OpenAI (embeddings)](#5-openai-embeddings-do-rag)
8. [Sentry](#6-sentry-monitoramento-de-erros)
9. [Resend (email transacional)](#7-resend-email-transacional)
10. [Nuvemshop](#8-nuvemshop-integração-e-commerce)
11. [Chaves geradas localmente](#9-chaves-geradas-localmente-encryption--internal-secret)
12. [Verificação final](#verificação-final)
13. [Troubleshooting](#troubleshooting)

---

## Antes de começar

**O que você precisa ter instalado:**
- Node.js 20 (`nvm use` no repo)
- Docker Desktop (pro WAHA local)
- Conta de email principal — vai usar pra criar contas em vários SaaS
- Cartão de crédito — alguns serviços pedem pra "comprovar identidade" mesmo no plano grátis (Supabase, Sentry). Você não vai ser cobrado se ficar dentro do free tier.

**Como o `.env.local` funciona:**
- O arquivo fica em `/Users/seu-user/DeskcommCRM/.env.local` (raiz do projeto)
- Cada linha é `NOME_DA_VARIAVEL=valor` — sem espaço antes/depois do `=`
- Strings com caracteres especiais: envolva em aspas duplas (`"valor com espaço"`)
- Variáveis com `NEXT_PUBLIC_` no nome são **expostas no browser** — nunca coloque secret aí
- O resto fica server-only

**Regra de ouro:** nunca commite o `.env.local`. Já está no `.gitignore`, mas confira com `git status` antes de qualquer push.

---

## Ordem recomendada

Se você quer rodar o app o mais rápido possível com o mínimo viável:

**Mínimo pra `npm run dev` subir sem erro fatal:**
1. Supabase (sem isso nada funciona — auth + DB)
2. Chaves geradas localmente (encryption + internal secret)
3. Upstash Redis (rate limit é gate de várias rotas)

**Pra testar features de IA:**
4. Anthropic key (ou AI Gateway)
5. OpenAI key (embeddings do RAG)

**Pra testar WhatsApp:**
6. WAHA + ngrok (precisa URL pública)

**Pode ficar vazio em dev (degradam graciosamente):**
- Sentry (não vai monitorar erros, mas app sobe)
- Resend (emails não saem, mas app sobe)
- Nuvemshop (UI mostra "Integração não configurada")

---

## 1. Supabase (banco + auth + storage)

**O que é:** Backend-as-a-service. Aqui mora seu Postgres, autenticação, storage de mídia e realtime. Sem isso, nada funciona.

### Passo a passo

1. Acesse <https://supabase.com> e clique **Start your project** → faça login com GitHub.
2. No dashboard, clique **New project**.
   - **Name:** `deskcomm-dev` (ou o que quiser)
   - **Database password:** clique no ícone de dado pra gerar. **Salve essa senha num gerenciador (1Password, Bitwarden)** — você vai precisar pra rodar migrations.
   - **Region:** `South America (São Paulo)` — latência mínima pro Brasil.
   - **Pricing plan:** Free.
3. Clique **Create new project**. Aguarde ~2 minutos enquanto provisiona.
4. Quando carregar, vá em **Project Settings** (engrenagem no menu lateral) → **API**.

### Onde pegar as 3 chaves

Na tela **Project Settings → API** você vai ver:

| Campo no Supabase | Variável no `.env.local` | Detalhe |
|---|---|---|
| **Project URL** (ex: `https://abc123.supabase.co`) | `NEXT_PUBLIC_SUPABASE_URL` | URL pública, pode ir pro browser |
| **Project API keys → `anon` `public`** | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Chave pública. RLS protege os dados |
| **Project API keys → `service_role` `secret`** | `SUPABASE_SERVICE_ROLE_KEY` | **CRÍTICA**. Bypassa RLS. Nunca exponha. Nunca commite. |

> ⚠️ **Aviso de segurança:** a `service_role` é o equivalente a senha de root do banco. Se vazar, qualquer pessoa lê/escreve tudo. Em prod, configure rotação trimestral.

### Rodar as migrations

Depois de preencher as 3 variáveis acima:

```bash
# Instale o CLI do Supabase se ainda não tiver
brew install supabase/tap/supabase

# Conecte ao seu projeto (precisa do ID — está na URL do dashboard)
supabase link --project-ref <seu-project-ref>

# Aplica todas as migrations do repo
supabase db push
```

Se não conseguir usar o CLI, copie cada arquivo de `supabase/migrations/*.sql` e cole em **SQL Editor → New query** no dashboard, em ordem alfabética. Trabalhoso mas funciona.

### Storage bucket

No menu lateral → **Storage** → **New bucket**:
- Name: `whatsapp-media`
- Public bucket: **NÃO** (deixe desmarcado — usamos URLs assinadas)

---

## 2. Upstash Redis (rate limit + idempotência)

**O que é:** Redis serverless. Usado pra rate limit de API e cache de idempotency keys.

### Passo a passo

1. Acesse <https://upstash.com> → **Sign up** com GitHub.
2. No dashboard, clique **Create Database**.
   - **Name:** `deskcomm-dev`
   - **Type:** Regional (mais barato que Global pra dev)
   - **Region:** `sa-east-1` (São Paulo) — ou `us-east-1` se SP não estiver disponível no free tier.
   - **Eviction:** habilitado (default).
3. Clique **Create**.
4. Na tela do banco criado, role até a seção **REST API**. Você vai ver:

| Campo no Upstash | Variável no `.env.local` |
|---|---|
| **UPSTASH_REDIS_REST_URL** (botão de copy) | `UPSTASH_REDIS_REST_URL` |
| **UPSTASH_REDIS_REST_TOKEN** (clique no olhinho pra revelar) | `UPSTASH_REDIS_REST_TOKEN` |

> 💡 O Upstash mostra os snippets prontos em vários formatos. Use a aba **`.env`** que ele já formata certo.

---

## 3. WAHA (WhatsApp)

**O que é:** Servidor que se conecta ao WhatsApp e expõe API HTTP. Roda em Docker. Em dev, sobe local; em prod, num VPS.

### Passo 1: gerar a API key (plaintext + hash)

```bash
# Gere uma string aleatória forte (no terminal)
openssl rand -hex 32
# → cola algo tipo: 7a3f9b2c1d4e5f6a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a
```

Esse é o **plaintext**. Copie. Agora gere o **hash SHA512 hex** dele:

```bash
echo -n "7a3f9b2c1d4e5f6a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a" | shasum -a 512 | cut -d' ' -f1
# → cola algo tipo (longão): 9f8e7d6c...mais 120 chars...
```

> ⚠️ **Erro #1 de quem clona o projeto:** confundir plaintext com hash. Memoriza:
> - O **container WAHA** recebe o **HASH** (no `docker-compose.yml`, env `WHATSAPP_API_KEY_PLAIN` ou `WHATSAPP_API_KEY` dependendo da versão — ver `docker-compose.yml` do repo)
> - O **app Next.js** envia o **PLAINTEXT** no header `X-Api-Key`
> - Por isso a variável `WAHA_API_KEY` no `.env.local` recebe o **PLAINTEXT**

### Passo 2: preencher .env.local

```env
WAHA_API_BASE_URL=http://localhost:3000
WAHA_API_KEY=<plaintext-gerado-acima>
WAHA_WEBHOOK_BASE_URL=<vamos-preencher-no-passo-3>
```

### Passo 3: URL pública pra webhook (ngrok)

WAHA precisa chamar nossa app de volta quando chega mensagem. Localhost não serve — precisa de URL HTTPS pública.

```bash
# Instale ngrok
brew install ngrok

# Cadastre conta grátis em https://ngrok.com e pegue seu authtoken
ngrok config add-authtoken <seu-token>

# Em outro terminal, expõe a porta 3001 (onde o Next.js vai rodar)
ngrok http 3001
```

O ngrok vai mostrar: `Forwarding https://abc-123-456.ngrok-free.app -> http://localhost:3001`

Copie a URL `https://...` e cole em:

```env
WAHA_WEBHOOK_BASE_URL=https://abc-123-456.ngrok-free.app
```

> ⚠️ A URL do ngrok muda toda vez que você reinicia (no plano free). Pague $8/mês pelo subdomínio fixo se for trabalhar muito com WAHA, ou use Cloudflare Tunnel (gratuito com domínio próprio).

### Passo 4: subir o WAHA

```bash
docker compose up -d
```

Confira em <http://localhost:3000/dashboard> que o WAHA está respondendo. Detalhes de uso (criar sessão, escanear QR) estão no `README.md`.

---

## 4. Anthropic + Vercel AI Gateway (IA)

**O que é:** O cérebro da IA conversacional. Usamos o **Vercel AI Gateway** preferencialmente (tem fallback automático entre provedores, observability, zero data retention) e o Anthropic direto como fallback.

### Opção A — Vercel AI Gateway (recomendado)

1. Acesse <https://vercel.com> → faça login.
2. No dashboard → **AI** (no menu lateral) → **Get started with AI Gateway**.
3. Clique **Create API Key** → dê o nome `deskcomm-dev` → copie a chave.

```env
AI_GATEWAY_API_KEY=<chave-do-gateway>
AI_GATEWAY_BASE_URL=https://ai-gateway.vercel.sh/v1
VERCEL_AI_GATEWAY_URL=https://ai-gateway.vercel.sh/v1
```

> 💡 Com o Gateway, o código usa strings tipo `"anthropic/claude-sonnet-4-6"` — o Gateway resolve qual provedor chamar. Se Anthropic estiver fora, ele tenta o backup automaticamente.

### Opção B — Anthropic direto (fallback ou se preferir)

1. Acesse <https://console.anthropic.com> → **Sign Up**.
2. Adicione método de pagamento (mesmo que seja só pra teste — eles dão $5 de crédito grátis).
3. **Settings → API Keys** → **Create Key** → nome `deskcomm-dev` → copie.

```env
ANTHROPIC_API_KEY=sk-ant-api03-...
```

> ⚠️ Se `AI_GATEWAY_API_KEY` estiver vazio, o worker `ai-response-worker` pula com `skip="ai_gateway_key_missing"` — o app sobe normal, só não responde com IA. Em dev tá ok. Em prod, configure pelo menos uma das duas.

---

## 5. OpenAI (embeddings do RAG)

**O que é:** Usado **só** pra gerar embeddings (vetores) das bases de conhecimento dos tenants pro chatbot RAG. Não usamos GPT pra gerar texto — esse trabalho é do Claude.

1. Acesse <https://platform.openai.com> → **Sign up**.
2. Adicione método de pagamento (eles não dão mais crédito grátis em conta nova, mas embeddings são baratíssimos — text-embedding-3-small custa $0.02 por 1M tokens).
3. **API Keys → Create new secret key** → nome `deskcomm-dev-embeddings` → copie.

```env
OPENAI_API_KEY=sk-proj-...
```

---

## 6. Sentry (monitoramento de erros)

**O que é:** Captura erros, stack traces e performance. Sem isso, você só sabe que o app quebrou quando o cliente reclama.

1. Acesse <https://sentry.io> → **Sign up** com GitHub.
2. Crie um workspace (ou use o pessoal) → **Create Project**.
   - **Platform:** `Next.js`
   - **Alert frequency:** "Alert me on every new issue"
   - **Project name:** `deskcomm-dev`
3. Após criar, o Sentry mostra o **DSN** numa tela de quickstart. É uma URL tipo `https://abc123@o456.ingest.sentry.io/789`.
4. Se você fechou a tela: **Project Settings → Client Keys (DSN)** → copie o "DSN" público.

```env
SENTRY_DSN=https://abc123@o456.ingest.sentry.io/789
```

> 💡 O DSN é considerado "público o suficiente" — pode ir no client. Mas mantenha como server var por padrão (já está em `.env.local`).

---

## 7. Resend (email transacional)

**O que é:** Serviço de envio de email. Usado pra magic links, reset de senha, notificações de tenant.

> ℹ️ **Nota:** A variável `RESEND_API_KEY` ainda não está no `.env.example` mas é referenciada em `sentry.server.config.ts` e na arquitetura. Adicione manualmente no seu `.env.local`.

1. Acesse <https://resend.com> → **Sign up** com GitHub.
2. **API Keys → Create API Key**:
   - **Name:** `deskcomm-dev`
   - **Permission:** `Sending access` (não `Full access`)
   - **Domain:** `All domains` (em dev) — em prod, restrinja ao domínio verificado.
3. Copie a chave (começa com `re_...`). **Ela só aparece uma vez.**

Adicione no `.env.local`:

```env
RESEND_API_KEY=re_...
RESEND_FROM_EMAIL=onboarding@resend.dev
```

> 💡 O domínio `onboarding@resend.dev` é compartilhado e funciona no plano free pra testes. Em prod, **verifique seu próprio domínio** no Resend (DNS records SPF + DKIM) e use `noreply@seudominio.com`.

---

## 8. Nuvemshop (integração e-commerce)

**O que é:** Plataforma de e-commerce brasileira. Nossa integração OAuth importa pedidos, produtos, clientes pro CRM.

> ℹ️ **Pode pular em dev.** Se essas vars ficarem vazias, a UI mostra "Integração não configurada" e você toca o resto do app normal.

### Passo a passo

1. Acesse <https://partners.tiendanube.com/> → **Sign up** como parceiro (gratuito).
2. No dashboard de parceiro → **Apps → Create new app**.
   - **App name:** `DeskcommCRM Dev`
   - **Redirect URI:** `https://<sua-url-ngrok>.ngrok-free.app/api/v1/integrations/nuvemshop/callback` (mesmo ngrok do WAHA, ou outro)
   - **Scopes:** marque tudo relacionado a `read_orders`, `read_customers`, `read_products`, `write_orders` (pra atualizar status)
3. Após criar, a tela do app mostra:

| Campo no portal | Variável no `.env.local` |
|---|---|
| **App ID** (na URL do painel do app, ex: `partners.tiendanube.com/apps/12345`) | `NUVEMSHOP_APP_ID` (= `12345`) |
| **Client ID** | `NUVEMSHOP_CLIENT_ID` |
| **Client Secret** (clique pra revelar) | `NUVEMSHOP_CLIENT_SECRET` |

```env
NUVEMSHOP_APP_ID=12345
NUVEMSHOP_CLIENT_ID=...
NUVEMSHOP_CLIENT_SECRET=...
```

4. Configure também:

```env
NEXT_PUBLIC_APP_URL=https://<sua-url-ngrok>.ngrok-free.app
```

A URL do callback OAuth precisa bater **exatamente** com a `Redirect URI` cadastrada no portal — incluindo `https`, sem barra final.

---

## 9. Chaves geradas localmente (encryption + internal secret)

Estas você **gera você mesmo** — não tem dashboard, não tem login. São strings aleatórias usadas pra criptografia interna.

```bash
# Rode 4x e cole cada saída numa variável diferente
openssl rand -hex 32
```

Distribua nas 4 variáveis:

```env
INTERNAL_SECRET=<saída-1>
CPF_ENCRYPTION_KEY=<saída-2>
NUVEMSHOP_OAUTH_ENCRYPTION_KEY=<saída-3>
WAHA_BYO_ENCRYPTION_KEY=<saída-4>
```

> ⚠️ **NUNCA reutilize** a mesma string em produção. Cada uma criptografa uma coisa diferente — se vazar uma, queremos blast radius limitado.
>
> ⚠️ **NUNCA mude `CPF_ENCRYPTION_KEY` ou `NUVEMSHOP_OAUTH_ENCRYPTION_KEY` depois que tiver dados em prod** — você não consegue mais descriptografar o que foi salvo. Rotação dessas chaves exige migration de re-encryption.

---

## Verificação final

Depois de preencher tudo, valide:

```bash
# 1. Type-check (vai reclamar de env faltando)
npm run typecheck

# 2. Sobe o app
npm run dev

# 3. Em outro terminal, bate no health check
curl http://localhost:3001/api/v1/health
```

A resposta deve ser tipo:
```json
{
  "data": {
    "supabase": "ok",
    "redis": "ok",
    "waha": "ok"
  }
}
```

Se algum service vier `"degraded"` ou `"down"`, abra o terminal do `npm run dev` e veja o erro — geralmente é variável faltando ou typo no valor.

---

## Troubleshooting

### `Error: supabaseUrl is required`
Você esqueceu de preencher `NEXT_PUBLIC_SUPABASE_URL` ou tem espaço/aspa errada. Confira se a linha é exatamente `NEXT_PUBLIC_SUPABASE_URL=https://abc.supabase.co` (sem aspas, sem espaço antes do `=`).

### `Invalid JWT` ao chamar Supabase
A `anon key` ou `service role key` foi colada errada (cortou no meio). JWTs do Supabase são longos (~200 chars). Volte no dashboard e use o botão **Copy** em vez de selecionar manualmente.

### WAHA retorna 401 `Unauthorized`
Provável: você botou o **hash** em `WAHA_API_KEY` em vez do **plaintext**. Confira: a app envia o que tá no `.env.local` no header — o container WAHA é quem tem o hash. Refaça o passo 1 do WAHA.

### Webhook do WAHA não chega
- O ngrok está rodando? (`ngrok http 3001`)
- A URL do ngrok atual está em `WAHA_WEBHOOK_BASE_URL`? (muda a cada restart)
- Você reiniciou o `npm run dev` depois de mudar o `.env.local`? Variáveis de ambiente são lidas no boot.

### `RESEND_API_KEY is undefined` (mas o app sobe)
Esperado em dev se você ainda não configurou o Resend. Emails não saem, mas nada quebra.

### Migrations não rodam
Confira se você está logado: `supabase login` — vai abrir o browser pra autorizar. Depois `supabase link --project-ref <ref>` de novo.

### Esqueci a senha do banco do Supabase
**Project Settings → Database → Reset database password**. Lembrando que isso invalida conexões existentes.

---

## Próximos passos

Com tudo verde no `/api/v1/health`:
1. Crie um usuário de teste seguindo `scripts/seed-e2e-credentials.ts`
2. Leia `tasks/todo.md` pra entender o backlog atual
3. Veja `README.md` pra fluxo de criar sessão WAHA + escanear QR

Bem-vindo ao DeskcommCRM. 🛠️
