-- 0028_contacts_custom_fields
--
-- Campos custom POR CONTATO, mesmo modelo já usado em crm_leads.custom_fields.
--
-- Motivação (Itaville pós-venda, 26/07/2026): a lista de contatos virou tela de
-- trabalho ativa — a atendente precisa marcar o Empreendimento do comprador, se
-- já ligou ("Liguei") e o status da abordagem, SEM abrir um atendimento. São
-- dados do contato, não do chamado.
--
-- jsonb livre: a definição dos campos (chave, rótulo, opções) vive na aplicação
-- (lib/contacts/fields.ts) — nenhum tenant precisa de coluna nova pra ter os
-- seus. Idempotente e portável em psql puro.

alter table public.contacts
  add column if not exists custom_fields jsonb default '{}'::jsonb not null;

comment on column public.contacts.custom_fields is
  'Campos custom por-tenant do contato (jsonb chave→valor). Renderização/validação na aplicação (lib/contacts/fields.ts). Mesmo padrão de crm_leads.custom_fields.';
