-- 0029_visibilidade_por_numero
--
-- Dois números de WhatsApp na mesma org, com PAREDE entre eles: cada atendente
-- vê só o(s) número(s) dela — conversas, mensagens, contatos e atendimentos.
--
-- Motivação (Itaville, 02/08/2026): Samilis segue no número atual, Júlia entra
-- só no número novo, Gabriela (gerente) vê tudo.
--
-- Por que no BANCO e não só na tela: hoje o isolamento é por tenant, então
-- qualquer membro lê todas as conversas da org pela API. Esconder no front
-- deixaria a porta aberta. E políticas RLS se SOMAM por OR — daí estas
-- substituírem as existentes em vez de acrescentar.
--
-- Regra de compatibilidade que evita tiro no pé: **quem não tem nenhum número
-- atribuído vê todos**. Sem isso, no instante do deploy todo mundo perderia
-- acesso (ninguém tem atribuição ainda). A parede só passa a valer para quem
-- receber uma atribuição explícita.
--
-- Idempotente; roda em psql puro.

-- ---------------------------------------------------------------------------
-- 1) De qual número é o contato
-- ---------------------------------------------------------------------------
-- Contato NÃO tem número por natureza (é da empresa, e o mesmo telefone não
-- pode existir duas vezes na org). Então marcamos o número de ORIGEM: quem veio
-- da planilha fica com o número atual; quem chegar pelo número novo nasce com
-- ele. Quando o mesmo cliente falar nos dois, as duas atendentes veem o contato
-- (ver fn_contact_visible: origem OU conversa num número visível).
alter table public.contacts
  add column if not exists owner_channel_session_id uuid
    references public.channel_sessions(id) on delete set null;

comment on column public.contacts.owner_channel_session_id is
  'Número de WhatsApp que originou o contato. Base da visibilidade por número (0029). NULL = sem dono, visível a todos.';

create index if not exists idx_contacts_owner_session
  on public.contacts (organization_id, owner_channel_session_id);

-- Backfill genérico: org que tem UM único número recebe esse número em todos os
-- contatos sem dono. Org com vários fica NULL (visível a todos) — não há como
-- adivinhar, e o admin atribui pela tela.
update public.contacts c
   set owner_channel_session_id = (
         select cs.id from public.channel_sessions cs
          where cs.organization_id = c.organization_id
       )
 where c.owner_channel_session_id is null
   and (select count(*) from public.channel_sessions cs2
         where cs2.organization_id = c.organization_id) = 1;

-- ---------------------------------------------------------------------------
-- 2) Quem vê qual número
-- ---------------------------------------------------------------------------
create table if not exists public.user_channel_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null,
  channel_session_id uuid not null references public.channel_sessions(id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid,
  constraint uniq_user_channel_session unique (user_id, channel_session_id)
);

comment on table public.user_channel_sessions is
  'Atribuição usuário↔número de WhatsApp (0029). SEM linha para o usuário = vê todos os números (compatibilidade). Gerente/admin vê tudo independente disto.';

create index if not exists idx_user_channel_sessions_user
  on public.user_channel_sessions (user_id, organization_id);

alter table public.user_channel_sessions enable row level security;

drop policy if exists user_channel_sessions_read on public.user_channel_sessions;
create policy user_channel_sessions_read on public.user_channel_sessions
  for select
  using (
    organization_id in (select public.fn_user_org_ids())
    or public.fn_is_platform_admin()
  );

-- Só gerente/admin distribui número (mesma régua de "administrar equipe").
drop policy if exists user_channel_sessions_write on public.user_channel_sessions;
create policy user_channel_sessions_write on public.user_channel_sessions
  for all
  using (
    (organization_id in (select public.fn_user_org_ids())
     and public.fn_user_role_in(organization_id) >= 3)
    or public.fn_is_platform_admin()
  )
  with check (
    (organization_id in (select public.fn_user_org_ids())
     and public.fn_user_role_in(organization_id) >= 3)
    or public.fn_is_platform_admin()
  );

-- ---------------------------------------------------------------------------
-- 3) Quais números o usuário atual pode ver
-- ---------------------------------------------------------------------------
create or replace function public.fn_user_session_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select cs.id
    from public.channel_sessions cs
   where cs.organization_id in (select public.fn_user_org_ids())
     and (
       -- gerente (3) e admin (4) veem todos os números da org
       public.fn_user_role_in(cs.organization_id) >= 3
       -- ninguém atribuiu número a este usuário nesta org → vê todos
       or not exists (
            select 1 from public.user_channel_sessions ucs
             where ucs.user_id = auth.uid()
               and ucs.organization_id = cs.organization_id
          )
       -- atribuição explícita
       or exists (
            select 1 from public.user_channel_sessions ucs
             where ucs.user_id = auth.uid()
               and ucs.channel_session_id = cs.id
          )
     );
$$;

comment on function public.fn_user_session_ids is
  'Números de WhatsApp visíveis ao usuário atual. Gerente/admin: todos. Sem atribuição: todos (compatibilidade). Com atribuição: só os atribuídos.';

-- Visibilidade do CONTATO: número de origem visível OU conversa num número
-- visível (cliente que falou nos dois aparece pros dois). SECURITY DEFINER de
-- propósito: chamada dentro da policy de crm_leads sem depender de RLS aninhada.
create or replace function public.fn_contact_visible(p_contact uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
           select 1 from public.contacts ct
            where ct.id = p_contact
              and (ct.owner_channel_session_id is null
                   or ct.owner_channel_session_id in (select public.fn_user_session_ids()))
         )
      or exists (
           select 1 from public.conversations cv
            where cv.contact_id = p_contact
              and cv.channel_session_id in (select public.fn_user_session_ids())
         );
$$;

comment on function public.fn_contact_visible is
  'O usuário atual pode ver este contato? Origem visível OU tem conversa num número visível (0029).';

-- ---------------------------------------------------------------------------
-- 4) Políticas: tenant E número
-- ---------------------------------------------------------------------------
-- conversations / messages têm channel_session_id: filtro direto.
drop policy if exists conversations_tenant_isolation_all on public.conversations;
create policy conversations_tenant_isolation_all on public.conversations
  using (
    (organization_id in (select public.fn_user_org_ids())
     and (channel_session_id is null
          or channel_session_id in (select public.fn_user_session_ids())))
    or public.fn_is_platform_admin()
  )
  with check (
    organization_id in (select public.fn_user_org_ids())
    or public.fn_is_platform_admin()
  );

drop policy if exists messages_tenant_isolation_all on public.messages;
create policy messages_tenant_isolation_all on public.messages
  using (
    (organization_id in (select public.fn_user_org_ids())
     and (channel_session_id is null
          or channel_session_id in (select public.fn_user_session_ids())))
    or public.fn_is_platform_admin()
  )
  with check (
    organization_id in (select public.fn_user_org_ids())
    or public.fn_is_platform_admin()
  );

-- contacts: inline (não usa fn_contact_visible pra não chamar função por linha
-- na própria tabela que a função consulta).
drop policy if exists tenant_isolation_contacts_all on public.contacts;
create policy tenant_isolation_contacts_all on public.contacts
  using (
    (organization_id in (select public.fn_user_org_ids())
     and (
       owner_channel_session_id is null
       or owner_channel_session_id in (select public.fn_user_session_ids())
       or exists (
            select 1 from public.conversations cv
             where cv.contact_id = contacts.id
               and cv.channel_session_id in (select public.fn_user_session_ids())
          )
     ))
    or public.fn_is_platform_admin()
  )
  with check (
    organization_id in (select public.fn_user_org_ids())
    or public.fn_is_platform_admin()
  );

-- crm_leads: segue o contato. Lead sem contato fica visível (não há como
-- atribuir, e some da vista de ninguém seria pior).
drop policy if exists tenant_isolation_crm_leads_all on public.crm_leads;
create policy tenant_isolation_crm_leads_all on public.crm_leads
  using (
    (organization_id in (select public.fn_user_org_ids())
     and (contact_id is null or public.fn_contact_visible(contact_id)))
    or public.fn_is_platform_admin()
  )
  with check (
    organization_id in (select public.fn_user_org_ids())
    or public.fn_is_platform_admin()
  );

-- O próprio CANAL: sem isto, o seletor de número do Inbox (que lista
-- channel_sessions) mostraria o número da colega. fn_user_session_ids é
-- SECURITY DEFINER, então consulta channel_sessions sem recursão de RLS.
drop policy if exists channel_sessions_tenant_isolation_all on public.channel_sessions;
create policy channel_sessions_tenant_isolation_all on public.channel_sessions
  using (
    (organization_id in (select public.fn_user_org_ids())
     and id in (select public.fn_user_session_ids()))
    or public.fn_is_platform_admin()
  )
  with check (
    organization_id in (select public.fn_user_org_ids())
    or public.fn_is_platform_admin()
  );

-- ---------------------------------------------------------------------------
-- 5) Contato criado pelo WhatsApp nasce marcado com o número
-- ---------------------------------------------------------------------------
-- Assinatura NOVA (com p_session). A antiga de 6 argumentos continua existindo
-- para não quebrar chamador antigo; a aplicação passa a usar esta.
create or replace function public.fn_upsert_wa_contact(
  p_org uuid,
  p_kind text,      -- 'phone' | 'lid'
  p_phone text,     -- +E164 (kind=phone) senão null
  p_lid text,       -- somente dígitos (kind=lid) senão null
  p_chat_id text,   -- chatId cru p/ source_metadata (auditoria)
  p_notify text,    -- notifyName/pushName, se houver
  p_session uuid    -- número que recebeu a mensagem (vira o dono do contato)
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  insert into public.contacts (
    organization_id, phone_number, source, consent, tags, source_metadata,
    display_name, owner_channel_session_id
  )
  values (
    p_org,
    case when p_kind = 'phone' then p_phone end,
    'whatsapp',
    '{}'::jsonb,
    '{}'::text[],
    case when p_kind = 'lid'
      then jsonb_build_object('waha_lid', p_lid, 'notify_name', nullif(p_notify, ''))
      else jsonb_build_object('waha_chat_id', p_chat_id, 'notify_name', nullif(p_notify, '')) end,
    nullif(p_notify, ''),
    p_session
  )
  on conflict (organization_id, wa_identity) where wa_identity is not null and is_merged_into is null
  do update set
    display_name = coalesce(contacts.display_name, excluded.display_name),
    -- contato que já existia sem dono ganha o número que falou com ele primeiro;
    -- quem já tem dono NÃO é reatribuído (senão o contato trocaria de lado a
    -- cada mensagem quando o cliente fala nos dois números).
    owner_channel_session_id = coalesce(contacts.owner_channel_session_id, p_session),
    updated_at = now()
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.fn_upsert_wa_contact(uuid, text, text, text, text, text, uuid) is
  'Resolve/cria contato WhatsApp pela identidade canônica (org, wa_identity) e marca o número de origem (0029). Elimina a corrida message/message.any.';

revoke all on function public.fn_upsert_wa_contact(uuid, text, text, text, text, text, uuid) from public;
grant execute on function public.fn_upsert_wa_contact(uuid, text, text, text, text, text, uuid) to service_role;
revoke all on function public.fn_user_session_ids() from public;
grant execute on function public.fn_user_session_ids() to authenticated, service_role;
revoke all on function public.fn_contact_visible(uuid) from public;
grant execute on function public.fn_contact_visible(uuid) to authenticated, service_role;
