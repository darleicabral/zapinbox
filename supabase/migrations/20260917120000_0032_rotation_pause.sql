-- 0032 — Pausar corretor do rodízio (folga) sem mexer no papel nem revogar acesso.
--
-- Antes, tirar alguém da roleta só dava pra fazer rebaixando o papel (viewer) ou
-- revogando — os dois com efeito colateral (perde acesso/vira só-leitura). Esta
-- coluna deixa o gestor pausar por um prazo: enquanto `rotation_paused_until` for
-- futuro, o membro NÃO recebe lead novo (pickNextAssignee/pickFirstEligible o
-- pulam). Expira sozinho, sem cron: passou a data, volta pro rodízio.

alter table public.user_organizations
  add column if not exists rotation_paused_until timestamptz;

comment on column public.user_organizations.rotation_paused_until is
  'Folga: quando setado e no futuro, o membro fica FORA do rodizio de leads (pickNextAssignee/pickFirstEligible). null = participa normalmente. Expira sozinho, sem cron.';
