-- 0033 — Web Push (PWA): assinaturas de push por usuário/org.
-- O corretor é mobile-first; o PWA (manifest+SW, já no ar) ganha notificação
-- nativa no aparelho quando um lead é atribuído/repassado/escalado pra ele —
-- complementa o aviso por WhatsApp (0029), que continua existindo.
-- Uma linha por endpoint (aparelho/navegador); o mesmo usuário pode ter vários.

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  unique (endpoint)
);

alter table public.push_subscriptions enable row level security;

-- Cada usuário gerencia as próprias assinaturas (dentro das orgs dele).
drop policy if exists "push_subscriptions_own" on public.push_subscriptions;
create policy "push_subscriptions_own" on public.push_subscriptions
  using (
    (user_id = auth.uid() and organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  )
  with check (
    (user_id = auth.uid() and organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  );

create index if not exists idx_push_subscriptions_org_user
  on public.push_subscriptions (organization_id, user_id);
