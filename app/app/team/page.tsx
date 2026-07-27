import Link from "next/link";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { canManageTeam } from "@/lib/auth/permissions";
import { Button } from "@/components/ui/button";
import { TeamMembersClient } from "./_components/TeamMembersClient";

export const dynamic = "force-dynamic";

export default async function TeamPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  // Gerente administra a equipe (menos os admins) desde 26/07.
  const canManage = !!activeOrg && canManageTeam(activeOrg.role);

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Equipe</h1>
          <p className="text-sm text-muted-foreground">
            Gestão de membros, roles e acesso ao tenant.
          </p>
        </div>
        {canManage ? (
          <div className="flex items-center gap-2">
            <Button asChild variant="outline">
              <Link href="/app/team/invite">Convidar por e-mail</Link>
            </Button>
            <Button asChild>
              <Link href="/app/team/novo">Novo usuário</Link>
            </Button>
          </div>
        ) : null}
      </header>

      <TeamMembersClient currentUserId={user.id} canManage={canManage} />
    </div>
  );
}
