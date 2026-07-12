-- 0031 — C3: catálogo estruturado de produtos/imóveis + associação por lead.
-- "Imóvel = produto." Tenant-aware com RLS tenant_isolation (padrão do 0028/0030).
-- Fluxo vivo: o bot busca no catálogo (crm_search_catalog) e anexa itens ao lead
-- (crm_link_lead_product); o corretor vê os imóveis de interesse no CRMSidePanel.
-- Genérico por design: colunas universais + `attributes` jsonb livre por tenant.

create table if not exists public.crm_products (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- id no sistema de origem (ex.: imóvel no Supabase da Avant) — chave de idempotência do import.
  external_ref text,
  kind text not null default 'imovel',      -- imovel | produto | servico...
  status text not null default 'active',    -- active | inactive | sold
  title text not null,
  description text,
  price_cents bigint,
  currency text not null default 'BRL',
  location text,                            -- bairro/cidade em texto (ex.: "Floramar, Belo Horizonte")
  url text,
  image_url text,
  attributes jsonb not null default '{}'::jsonb,  -- campos livres por tenant (quartos, vagas, área...)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, external_ref)
);

alter table public.crm_products enable row level security;

drop policy if exists "tenant_isolation_crm_products_all" on public.crm_products;
create policy "tenant_isolation_crm_products_all" on public.crm_products
  using ((organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin())
  with check ((organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin());

create or replace trigger crm_products_updated_at
  before update on public.crm_products
  for each row execute function public.fn_set_updated_at();

create index if not exists idx_crm_products_org_status on public.crm_products (organization_id, status);
create index if not exists idx_crm_products_org_kind on public.crm_products (organization_id, kind);

-- Associação lead ↔ produto/imóvel de interesse.
create table if not exists public.crm_lead_products (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null references public.crm_leads(id) on delete cascade,
  product_id uuid not null references public.crm_products(id) on delete cascade,
  relation text not null default 'interest',  -- interest | proposal | visit | discarded
  note text,
  created_by text not null default 'ai',       -- ai | user:<uuid>
  created_at timestamptz not null default now(),
  unique (lead_id, product_id)
);

alter table public.crm_lead_products enable row level security;

drop policy if exists "tenant_isolation_crm_lead_products_all" on public.crm_lead_products;
create policy "tenant_isolation_crm_lead_products_all" on public.crm_lead_products
  using ((organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin())
  with check ((organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin());

create index if not exists idx_crm_lead_products_lead on public.crm_lead_products (lead_id);
create index if not exists idx_crm_lead_products_product on public.crm_lead_products (product_id);
