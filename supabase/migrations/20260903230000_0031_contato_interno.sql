-- 0031 — contato INTERNO (telefone de aviso da equipe)
--
-- Decisão do Darlei (03/09/2026): "marcar como interna".
--
-- O problema: quando o CRM manda o aviso de lead pro WhatsApp do corretor, o
-- WAHA devolve o eco (fromMe) e o ingest cria um contato e uma conversa com o
-- PRÓPRIO corretor. Essa conversa nasce `pending`, e o vigia de SLA a trata
-- como lead: atribui pra outro corretor e dispara aviso novo. Laço. Hoje o
-- número do Cleber (+553192831280) estava aparecendo como lead no inbox.
--
-- A conversa continua existindo (o gestor quer o rastro de que avisou), mas
-- deixa de ser lead: fica fora do inbox de atendimento, do rodízio/SLA, do
-- follow-up e do bot.
alter table public.contacts
  add column if not exists is_internal boolean not null default false;

comment on column public.contacts.is_internal is
  'Contato da própria equipe (telefone de aviso de um membro). A conversa existe para histórico, mas não é lead: fora do inbox, do SLA/rodízio, do follow-up e do bot.';

create index if not exists contacts_org_interno_idx
  on public.contacts (organization_id)
  where is_internal;

-- Backfill. Cuidado com o NONO DÍGITO: o telefone de aviso é digitado no
-- formato novo (+5531992831280, 13 dígitos) e o contato nasce do JID real do
-- WhatsApp, que em conta antiga vem SEM o 9 (553192831280, 12 dígitos). Sem
-- comparar as duas formas o backfill não acha ninguém.
with membros as (
  select uo.organization_id,
         regexp_replace(uo.notify_whatsapp_e164, '\D', '', 'g') as dig
  from public.user_organizations uo
  where uo.notify_whatsapp_e164 is not null
    and uo.revoked_at is null
),
variantes as (
  select organization_id, dig from membros where length(dig) between 10 and 15
  union
  -- mesma linha sem o nono dígito: 55 + DDD + 9XXXXXXXX -> 55 + DDD + XXXXXXXX
  select organization_id, substr(dig, 1, 4) || substr(dig, 6) as dig
  from membros
  where length(dig) = 13 and substr(dig, 5, 1) = '9'
)
update public.contacts c
   set is_internal = true,
       updated_at = now()
 where c.is_internal = false
   and c.phone_number is not null
   and exists (
     select 1
       from variantes v
      where v.organization_id = c.organization_id
        and v.dig = regexp_replace(c.phone_number, '\D', '', 'g')
   );
