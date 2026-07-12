-- 0030 — C1: follow-up por inatividade (cadência de reengajamento por tenant).
-- Lead parou de responder E não foi transferido ("Só um momento" NÃO disparou):
-- a plataforma envia mensagens no timer. Se o lead responder, a cadência para.
-- Padrões copiados do 0028 (attendance): tabela por-tenant, RLS tenant_isolation.

create table if not exists public.followup_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  enabled boolean not null default false,
  -- Pausa (segundos) entre envios no mesmo tick, anti-banimento.
  throttle_seconds integer not null default 3 check (throttle_seconds between 0 and 60),
  -- Janela de expediente (mesmo shape do BusinessHours do C4); null = sempre.
  business_hours jsonb,
  -- Etapas: array de { after_minutes:int (inatividade desde a última msg do lead),
  --                     message:text ({nome} vira o 1º nome), discard?:bool }
  -- Etapa com discard=true encerra: move o lead pra etapa "perdido" e resolve a conversa.
  steps jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.followup_settings enable row level security;

drop policy if exists "tenant_isolation_followup_settings_all" on public.followup_settings;
create policy "tenant_isolation_followup_settings_all" on public.followup_settings
  using ((organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin())
  with check ((organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin());

create or replace trigger followup_settings_updated_at
  before update on public.followup_settings
  for each row execute function public.fn_set_updated_at();

-- Estado por conversa: quantas etapas já foram enviadas + quando a última saiu.
alter table public.conversations
  add column if not exists followup_step integer not null default 0,
  add column if not exists last_followup_at timestamptz;

-- Varredura do worker: conversas ainda com o bot (não transferidas), por org.
create index if not exists idx_conversations_followup_watch
  on public.conversations (organization_id, status, last_inbound_at)
  where status in ('open', 'ai_handling');
