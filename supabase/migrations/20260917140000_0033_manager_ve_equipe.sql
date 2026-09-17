-- 0033 — Gerente enxerga a equipe da própria org.
--
-- Sintoma: o gerente (ex.: Cleber, na Avant) só via ELE MESMO no menu "Atribuir"
-- do inbox e na tela de Equipe — não conseguia distribuir lead pra outro corretor.
--
-- Causa: a policy de SELECT de user_organizations só liberava ver TODOS os membros
-- pro admin; o gerente caía no ramo `user_id = auth.uid()` e via só a própria linha.
-- Isso contradiz o app, que dá gestão de equipe ao gerente (canManageTeam = manager+).
--
-- Correção: trocar 'admin' por 'manager' no SELECT. Gerente e admin veem todos;
-- agente/viewer seguem vendo só a si (não precisam da lista e não devem ver os
-- telefones de aviso dos colegas). UPDATE/DELETE seguem admin-only de propósito.

alter policy user_orgs_select on public.user_organizations
  using (
    (user_id = auth.uid())
    or fn_role_at_least(organization_id, 'manager')
    or fn_is_platform_admin()
  );
