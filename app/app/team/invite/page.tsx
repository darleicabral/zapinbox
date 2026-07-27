import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { canManageTeam } from "@/lib/auth/permissions";
import { InviteForm } from "./_components/InviteForm";

export const dynamic = "force-dynamic";

export default async function TeamInvitePage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg || !canManageTeam(activeOrg.role)) {
    redirect("/403");
  }

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Convidar membros</h1>
        <p className="text-sm text-muted-foreground">
          Cole até 20 emails (um por linha) e escolha a role compartilhada.
        </p>
      </header>
      <InviteForm />
    </div>
  );
}
