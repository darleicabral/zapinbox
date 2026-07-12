-- 0028 — C4: rodízio de atendimento (round-robin com ponteiro) + SLA em 2 etapas.
-- Decisões aprovadas (ESTADO.md § Decisões tomadas 11/07/2026):
--   "atendido" em 2 etapas (claim em X min → repassa; 1ª resposta em Y min → alerta gestor),
--   pula atendente offline, round-robin puro, fallback gestor após N repasses,
--   tudo configurável por tenant.
-- Padrões copiados do baseline: tabela por-feature com PK organization_id (como ai_budgets),
-- RLS tenant_isolation via fn_user_org_ids()/fn_is_platform_admin(), trigger fn_set_updated_at.

-- 1) Config + estado do rodízio por tenant -----------------------------------
create table if not exists public.attendance_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  enabled boolean not null default false,
  -- Etapa 1: minutos para o atendente clicar "Assumir" antes de repassar.
  claim_sla_minutes integer not null default 5 check (claim_sla_minutes between 1 and 1440),
  -- Etapa 2: minutos para a 1ª resposta após o claim antes de alertar o gestor.
  first_response_sla_minutes integer not null default 10 check (first_response_sla_minutes between 1 and 1440),
  -- Fallback: após N repasses sem claim, atribui ao gestor/admin.
  max_passes integer not null default 3 check (max_passes between 1 and 10),
  -- Mesmo shape do BusinessHoursConfig do trigger_config de agentes
  -- ({timezone, days, start, end}); null = sem restrição de expediente.
  business_hours jsonb,
  -- Ponteiro do rodízio circular (último atribuído).
  last_assigned_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.attendance_settings enable row level security;

create policy "tenant_isolation_attendance_settings_all" on public.attendance_settings
  using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  )
  with check (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

create or replace trigger attendance_settings_updated_at
  before update on public.attendance_settings
  for each row execute function public.fn_set_updated_at();

-- 2) Presença mínima do atendente (heartbeat) --------------------------------
-- online = presence='online' E presence_updated_at fresco (staleness na aplicação,
-- sem cron de auto-offline).
alter table public.user_organizations
  add column if not exists presence text not null default 'offline'
    check (presence in ('online', 'busy', 'offline')),
  add column if not exists presence_updated_at timestamptz;

-- 3) Estado de SLA na conversa ------------------------------------------------
alter table public.conversations
  add column if not exists assignment_passes integer not null default 0,
  add column if not exists first_response_alerted_at timestamptz;

-- Varredura do worker de SLA: conversas pendentes atribuídas (etapa 1) e
-- claimed (etapa 2), por org.
create index if not exists idx_conversations_sla_watch
  on public.conversations (organization_id, status, assigned_at)
  where status in ('pending', 'claimed');
