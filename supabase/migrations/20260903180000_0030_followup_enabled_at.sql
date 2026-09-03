-- 0030_followup_enabled_at
-- Marca QUANDO o reengajamento foi ativado, pra a cadência valer só pra conversa
-- criada depois desse instante.
--
-- Por que existe: em 03/09/2026 ligar o reengajamento disparou 116 mensagens pra
-- 34 conversas em cinco minutos. Todas estavam paradas há horas, então todas já
-- tinham cruzado o prazo da 1ª etapa no instante do "ligar". Decisão do Darlei:
-- ao ativar, a cadência se aplica APENAS a lead novo, que chegar a partir da
-- ativação. Sem guardar o instante da ativação não existe esse corte.
--
-- Idempotente — safe to re-apply.

alter table public.followup_settings
  add column if not exists enabled_at timestamptz;

comment on column public.followup_settings.enabled_at is
  'Instante da última ATIVAÇÃO do reengajamento. A cadência só pega conversa com created_at > enabled_at (decisão 03/09/2026, incidente do disparo em massa). Null = nunca ativado; o worker não varre nada nesse caso.';

-- Tenant que JÁ está com enabled=true e sem enabled_at ficaria varrendo o acervo
-- inteiro na primeira passada — exatamente o incidente. Marca "agora" pra esses,
-- que é o comportamento seguro: a partir de agora, só conversa nova.
update public.followup_settings
   set enabled_at = now()
 where enabled = true
   and enabled_at is null;
