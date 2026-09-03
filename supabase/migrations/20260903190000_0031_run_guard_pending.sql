-- 0031_run_guard_pending
-- A trava de concorrência ("1 run por conversa") passa a cobrir `pending`.
--
-- Por que existe: o índice antigo cobria só `status='running'`, mas o
-- despachante INSERE a linha como `pending`. Dois despachos no mesmo tique
-- passavam pela pré-checagem (ninguém 'running' ainda), inseriam dois `pending`
-- sem colidir, e os dois rodavam.
--
-- Sintoma medido em 03/09/2026, conversa bb7cd91b: o lead mandou duas mensagens
-- no mesmo segundo (17:22:05), viraram dois runs às 17:22:08, e o bot deu a
-- abertura completa DUAS vezes — cumprimento, resumo do imóvel e a pergunta,
-- tudo repetido, porque nenhum dos dois viu a resposta do outro. O Darlei
-- descreveu como "a IA fica conversando sozinha". Mandar 2 mensagens seguidas é
-- o comportamento normal de quem usa WhatsApp, então isso acontecia direto.
--
-- Dry-runs seguem fora do guard (vários testes em paralelo são OK).
-- Idempotente — safe to re-apply.

drop index if exists public.ai_agent_runs_one_running_per_conv;

create unique index if not exists ai_agent_runs_one_inflight_per_conv
  on public.ai_agent_runs (conversation_id)
  where status in ('pending', 'running') and is_dry_run = false;

comment on index public.ai_agent_runs_one_inflight_per_conv is
  'Anti-resposta-dupla: 1 run EM VOO (pending ou running) por conversa. Cobria só running até 03/09/2026, e o insert é pending — dois despachos simultâneos escapavam e o bot respondia duas vezes.';
