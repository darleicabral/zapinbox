import { redirect } from "next/navigation";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { loadOnboardingState } from "@/app/actions/onboarding/_shared";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

export default async function OnboardingIndex() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/login");

  const { state, onboardedAt } = await loadOnboardingState(activeOrg.orgId);
  if (onboardedAt) redirect("/app/inbox");

  if (!state.welcome) redirect("/onboarding/welcome");
  if (!state.whatsapp) redirect("/onboarding/connect-whatsapp");
  // Template genérico: só empurra o passo Nuvemshop quando a integração está ligada.
  if (env.NUVEMSHOP_ENABLED && !state.nuvemshop) redirect("/onboarding/connect-nuvemshop");
  if (!state.ai) redirect("/onboarding/setup-ai");
  if (!state.team) redirect("/onboarding/invite-team");
  redirect("/onboarding/done");
}
