-- 0029 — C4 (notificação): avisar o corretor por WhatsApp quando um lead cai
-- pra ele. Corretores são mobile-first e vivem no WhatsApp — a presença por
-- aba aberta (0028) não alcança eles; o ping no WhatsApp sim.

-- Número de WhatsApp do membro (E.164, ex. +5531999998888) para receber os
-- avisos de novo lead / repasse. Null = não notificar esse membro.
alter table public.user_organizations
  add column if not exists notify_whatsapp_e164 text
    check (notify_whatsapp_e164 is null or notify_whatsapp_e164 ~ '^\+[1-9][0-9]{7,14}$');

-- Liga/desliga a notificação por WhatsApp por tenant (default ligado).
alter table public.attendance_settings
  add column if not exists notify_whatsapp boolean not null default true;
