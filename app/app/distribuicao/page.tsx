import { redirect } from "next/navigation";

import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";

import { DistribuicaoClient } from "./_client";

export const dynamic = "force-dynamic";

/**
 * Distribuição de leads por corretor. Gestor pra cima: o corretor já só vê os
 * leads dele no inbox, e um painel comparativo seria a porta dos fundos disso.
 */
export default async function DistribuicaoPage() {
  const authUser = await loadAuthUser();
  const activeOrg = authUser ? await resolveActiveOrg(authUser) : null;
  if (!activeOrg || ROLE_RANK[activeOrg.role] < ROLE_RANK["manager"]) {
    redirect("/app/inbox");
  }
  return <DistribuicaoClient />;
}
