import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { canManageTeam } from "@/lib/auth/permissions";
import { NewMemberForm } from "./_components/NewMemberForm";

export const dynamic = "force-dynamic";

/**
 * /app/team/novo — cadastro direto de membro (admin-only).
 *
 * Diferente do convite: a conta já nasce ativa com a senha que o admin define,
 * porque na operação real a pessoa está do lado e esperar e-mail só atrasa.
 */
export default async function NewMemberPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg || (!user.is_platform_admin && !canManageTeam(activeOrg.role))) {
    redirect("/403");
  }

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Novo usuário</h1>
        <p className="text-sm text-muted-foreground">
          Cria o acesso na hora, com senha definida por você, em {activeOrg.name}. Escolha o nível e
          confira ao lado o que ele libera.
        </p>
      </header>
      <NewMemberForm />
    </div>
  );
}
