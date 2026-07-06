<div align="center">

# 🛠️ DeskcommCRM

**CRM operacional multi-tenant para e-commerce, com IA conversacional nativa, WhatsApp via WAHA e LGPD by-design.**

[![Next.js 15](https://img.shields.io/badge/Next.js-15-black?logo=next.js)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript)](https://www.typescriptlang.org)
[![Supabase](https://img.shields.io/badge/Supabase-Postgres%2BAuth%2BStorage-3ecf8e?logo=supabase)](https://supabase.com)
[![Tailwind](https://img.shields.io/badge/Tailwind-CSS-38bdf8?logo=tailwindcss)](https://tailwindcss.com)
[![License: TBD](https://img.shields.io/badge/license-TBD-lightgrey)](#licença)

[**📘 Setup Guide**](docs/SETUP.md) · [**🏗️ Arquitetura**](ARCHITECTURE.md) · [**🤝 Contribuir**](CONTRIBUTING.md) · [**📋 PRDs**](docs/prd/) · [**🗺️ Roadmap**](docs/stories/epics/MASTER.md)

</div>

---

## ✨ O que é

DeskcommCRM unifica **atendimento humano**, **chatbot com RAG por tenant**, **gestão de pedidos** e **pipeline de pós-venda** numa única plataforma. Canal primário: **WhatsApp via WAHA**. Multi-tenant desde o dia 1. LGPD nativa.

> **Modo atual:** BPO interno (uma operadora atende N tenants).
> **Modo futuro:** SaaS direto pra lojistas.

### Diferenciais

- 🤖 **IA operando o atendimento** com RAG por tenant — não é chatbot decorativo, é triagem real.
- 🛒 **E-commerce-native** — vocabulário desenhado pro ciclo *Carrinho abandonado → Pago → Enviado → Entregue → Pós-venda*.
- 🇧🇷 **LGPD by-design** — webhooks `customer/redact` e `customer/data_request` da Nuvemshop como contrato de primeira-classe; anonimização preferida sobre delete; audit append-only com retenção 5 anos.
- 🔌 **MCP-ready** (Fase 2) — exporta capabilities pro ecossistema de agentes.
- 🏢 **Multi-tenant de verdade** — RLS em toda tabela tenant-aware, teste de isolamento como gate de CI.

---

## 🚀 Quickstart (5 minutos pra ver rodando)

```bash
# 1. Clone
git clone https://github.com/melgarafael/DeskcommCRM.git
cd DeskcommCRM

# 2. Node 20 + pnpm
nvm use                    # ou instale Node 20+
npm install -g pnpm
pnpm install

# 3. Env vars
cp .env.example .env.local
# Edite .env.local — guia completo em docs/SETUP.md

# 4. WAHA local (opcional em dev sem WhatsApp)
docker compose up -d

# 5. Migrations Supabase
supabase link --project-ref <seu-ref>
supabase db push

# 6. Sobe o app
pnpm dev
```

App: <http://localhost:3000> · Health check: <http://localhost:3000/api/v1/health>

> 🆕 **Primeira vez? Não pula etapa.** [`docs/SETUP.md`](docs/SETUP.md) é o tutorial completo passo a passo de **todas as integrações** (Supabase, WAHA, Anthropic, Upstash, Sentry, Resend, Nuvemshop) — feito pra quem nunca configurou nada disso antes. ~60–90 min do zero ao app rodando.

---

## 🧱 Stack

| Camada | Escolha | Por quê |
|---|---|---|
| **Frontend** | Next.js 15 App Router + TypeScript estrito | Server Components + Route Handlers no mesmo repo |
| **Estilo** | Tailwind + shadcn/ui (`new-york`, neutral) | Customizável sem lock-in |
| **DB** | Supabase (Postgres + RLS + `vector`) | Multi-tenant nativo, embedding pra RAG |
| **Auth** | Supabase Auth via `@supabase/ssr` | Cookie SameSite=Strict, HttpOnly |
| **Realtime** | Supabase Realtime | postgres_changes + broadcast |
| **Storage** | Supabase Storage (URLs assinadas) | Bucket privado `whatsapp-media` |
| **WhatsApp** | WAHA Plus (engine NOWEB) | Multi-tenant, retry, S3 |
| **Filas** | `event_log` table + workers (cron) | Sem Inngest/Trigger no MVP |
| **Rate limit** | Upstash Redis (sliding window) | Serverless, free tier suficiente |
| **AI** | Vercel AI Gateway (Anthropic primário, OpenAI embeddings) | Fallback automático, ZDR |
| **Validação** | Zod | Input externo, env, payloads |
| **Observability** | Sentry (com `beforeSend` sanitizado) | Sem PII no breadcrumb |
| **Hospedagem** | Vercel (app) + Hostgator VPS Turing/SP (WAHA) | Edge + dedicado pra WhatsApp; datacenter Brasil |

Detalhes: [`ARCHITECTURE.md`](ARCHITECTURE.md).

---

## 📁 Estrutura

```
DeskcommCRM/
├── app/                    # Next.js App Router
│   ├── (admin)/            # Rotas super-admin (impersonate, tenants)
│   ├── (public)/           # Login, recovery
│   ├── app/                # Rotas autenticadas (inbox, kanban, contacts, audit)
│   └── api/v1/             # API REST canônica
├── components/             # React (ui/, empty/, feedback/, shell/)
├── lib/                    # supabase/, waha/, ai/, api/, logger.ts, env.ts
├── hooks/
├── supabase/migrations/    # SQL versionado
├── tests/{e2e,unit}/
├── scripts/                # seeds, qa-waves, manutenção
├── docs/                   # PRDs, specs, stories, SETUP.md
├── workers/                # consumers de event_log
└── tasks/                  # backlog ativo
```

---

## 🧪 Testes

```bash
pnpm typecheck     # tsc --noEmit (estrito)
pnpm lint          # eslint next/core-web-vitals
pnpm test:unit     # Vitest
pnpm test:e2e      # Playwright (requer dev server)
```

CI roda todos antes de merge. **Teste de isolamento RLS é gate obrigatório** — cria 2 tenants e verifica não-vazamento.

---

## ⌨️ Atalhos de teclado

- `Tab` / `Shift+Tab` — navegação focável (login, formulários, kanban cards)
- `Enter` — confirma ações primárias
- `Esc` — fecha dialogs/sheets

Documentação completa de keyboard shortcuts vem com EPIC-04 (kanban) e EPIC-03 (inbox).

---

## 📚 Documentação

| Doc | O que tem |
|---|---|
| [`docs/SETUP.md`](docs/SETUP.md) | **Setup completo passo a passo** de todas as integrações |
| [`CLAUDE.md`](CLAUDE.md) | Convenções não-negociáveis (leitura obrigatória pra contribuir) |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Visão de 1 página da arquitetura |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Fluxo PR + epic-executor |
| [`docs/prd/`](docs/prd/) | PRDs (master, platform, customer 360, WhatsApp, pipeline, IA-RAG, Nuvemshop) |
| [`docs/specs/`](docs/specs/) | Specs técnicas detalhadas (schema SQL, payloads exatos) |
| [`docs/business-rules/`](docs/business-rules/) | Regras de negócio fora do código |
| [`docs/stories/epics/MASTER.md`](docs/stories/epics/MASTER.md) | Plano de execução wave-by-wave |
| [`docs/DEPLOY-CHECKLIST.md`](docs/DEPLOY-CHECKLIST.md) | Preflight pré-go-live |
| [`docs/runbooks/waha-hostgator.md`](docs/runbooks/waha-hostgator.md) | Runbook completo de WAHA em produção (VPS Hostgator) |

---

## 🤝 Contribuindo

Esse projeto é open source pra comunidade. Toda contribuição é bem-vinda — desde fix de typo em doc até epic novo.

**Antes de abrir PR:**

1. Leia [`CLAUDE.md`](CLAUDE.md) (~5 min) — convenções não-negociáveis (multi-tenancy, RLS, audit, LGPD).
2. Leia [`CONTRIBUTING.md`](CONTRIBUTING.md) — fluxo de branches, commits, epic-executor.
3. Identifique o epic em [`docs/stories/epics/MASTER.md`](docs/stories/epics/MASTER.md).

**Fluxo curto:**

```bash
git checkout -b feat/EPIC-XX-short-slug
# implementa + testes
pnpm typecheck && pnpm lint && pnpm test:unit
git commit -m "feat(EPIC-XX): descrição"
# abre PR
```

**Definition of Done:** typecheck zero, lint zero, testes relevantes verdes, RLS testada se toca tabela tenant-aware, audit log emitido em mutações, sem `console.log` esquecido. Detalhes em [`CLAUDE.md`](CLAUDE.md#definition-of-done).

---

## 🐛 Reportando bugs

Abra uma [issue](https://github.com/melgarafael/DeskcommCRM/issues) com:
- Versão do Node, pnpm e SO.
- Output do `/api/v1/health`.
- Stack trace ou screenshot.
- Steps to reproduce.

Pra **vulnerabilidades de segurança**, **NÃO abra issue pública**. Mande email pra `security@deskcomm.app` (a definir) ou DM ao mantenedor.

---

## 🗺️ Roadmap (alto nível)

- ✅ **Fase 1 — MVP (8–12 semanas)**: Auth, multi-tenancy, inbox WhatsApp, kanban, customer 360, RAG, integração Nuvemshop, LGPD.
- 🔜 **Fase 1.5 — Hardening (+4–8 semanas)**: observability, performance, anti-banimento avançado.
- 🔜 **Fase 2 — Escala**: MCP público, identity probabilística, integrações VTEX/Shopify, modo SaaS direto.

Detalhe wave-by-wave: [`docs/stories/epics/MASTER.md`](docs/stories/epics/MASTER.md).

---

## 💬 Comunidade

- **Discussões:** [GitHub Discussions](https://github.com/melgarafael/DeskcommCRM/discussions) — pra perguntas, ideias, showcase.
- **Issues:** [GitHub Issues](https://github.com/melgarafael/DeskcommCRM/issues) — bugs e tasks.
- **Twitter / X:** [@rafaelmelgaco](https://twitter.com) (a confirmar).

---

## 📜 Licença

> ⚠️ **A definir.** O projeto está sendo liberado pra comunidade — a licença final (MIT, Apache-2.0, AGPL-3.0 ou outra) será definida antes do release público. Por enquanto, considere "all rights reserved" até o `LICENSE` ser commitado.

---

## 🙏 Agradecimentos

- **WAHA** ([devlikeapro](https://waha.devlikeapro.com/)) — engine WhatsApp.
- **Supabase** — Postgres + Auth + Storage + Realtime numa stack só.
- **Vercel** — hosting + AI Gateway.
- **Anthropic** (Claude) — IA conversacional.
- **shadcn/ui** — base de componentes.
- Comunidade brasileira de e-commerce que validou as primeiras hipóteses.

---

<div align="center">

**Built with ☕ in Brasil** · **Made for the community**

</div>
