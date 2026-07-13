-- 0032 — fn_upsert_wa_contact casa por QUALQUER chave (phone OU lid).
--
-- Por quê: o WhatsApp alterna o endereçamento do MESMO chat entre @lid e
-- número (addressingMode lid|pn), e o ingest agora descobre o número real de
-- chats @lid (key.remoteJidAlt) e preenche contacts.phone_number. Como
-- wa_identity é coluna GERADA que prioriza phone: sobre lid:, preencher o
-- número "flipa" a identidade — e a próxima mensagem endereçada por @lid não
-- encontra mais o contato (ON CONFLICT só olhava wa_identity) e cria contato
-- + conversa duplicados, onde o bot não está silenciado (fala pós-handoff).
--
-- Fix: matching explícito por phone OU waha_lid (source_metadata preserva o
-- lid mesmo após o flip), com fallback de INSERT + retry em unique_violation
-- (corrida message/message.any continua coberta pelo unique index).
-- Duplicados pré-existentes: mergear manualmente (messages/ai_agent_runs →
-- conversa boa; contato duplicado ganha is_merged_into) — fora desta migration
-- por conterem dados de produção.

create or replace function public.fn_upsert_wa_contact(
  p_org uuid,
  p_kind text,      -- 'phone' | 'lid'
  p_phone text,     -- +E164 (kind=phone) senão null
  p_lid text,       -- somente dígitos (kind=lid) senão null
  p_chat_id text,   -- chatId cru p/ source_metadata (auditoria)
  p_notify text     -- notifyName/pushName, se houver
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  -- 1) Match por QUALQUER chave conhecida do contato (não só a wa_identity
  --    atual): número em phone_number/wa_identity, lid em wa_identity OU no
  --    source_metadata (que sobrevive ao flip lid->phone).
  select id into v_id
  from public.contacts
  where organization_id = p_org
    and is_merged_into is null
    and (
      (p_kind = 'phone' and (phone_number = p_phone or wa_identity = 'phone:' || p_phone))
      or
      (p_kind = 'lid' and (wa_identity = 'lid:' || p_lid or source_metadata->>'waha_lid' = p_lid))
    )
  order by created_at
  limit 1;

  if v_id is not null then
    update public.contacts set
      display_name = coalesce(display_name, nullif(p_notify, '')),
      source_metadata = source_metadata
        || case when p_kind = 'lid' then jsonb_build_object('waha_lid', p_lid) else '{}'::jsonb end
        || case when nullif(p_notify, '') is not null
             then jsonb_build_object('notify_name', p_notify) else '{}'::jsonb end,
      updated_at = now()
    where id = v_id;
    return v_id;
  end if;

  -- 2) Não existe: cria. A corrida message/message.any (dois inserts em
  --    paralelo) cai no unique (org, wa_identity) — o perdedor relê.
  begin
    insert into public.contacts (
      organization_id, phone_number, source, consent, tags, source_metadata, display_name
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
      nullif(p_notify, '')
    )
    returning id into v_id;
  exception when unique_violation then
    select id into v_id
    from public.contacts
    where organization_id = p_org
      and is_merged_into is null
      and wa_identity = case when p_kind = 'phone' then 'phone:' || p_phone else 'lid:' || p_lid end;
  end;

  return v_id;
end;
$$;

comment on function public.fn_upsert_wa_contact is
  'Resolve/cria contato WhatsApp casando por QUALQUER chave (phone OU lid de source_metadata) — o WhatsApp alterna o endereçamento do mesmo chat. Atômico via unique (org, wa_identity) + retry.';
