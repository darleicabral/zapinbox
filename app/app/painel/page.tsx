import { redirect } from "next/navigation";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { hasPosvendaModule } from "@/lib/modules";
import { PosvendaClient } from "./_client";

export const dynamic = "force-dynamic";

export default async function PainelPage() {
  const authUser = await loadAuthUser();
  const activeOrg = authUser ? await resolveActiveOrg(authUser) : null;
  if (!activeOrg || !hasPosvendaModule(activeOrg.orgId)) {
    redirect("/app/inbox");
  }
  return <PosvendaClient orgName={activeOrg.name} />;
}
