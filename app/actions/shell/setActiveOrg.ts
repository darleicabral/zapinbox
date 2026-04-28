"use server";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { loadAuthUser } from "@/lib/auth/server";

export async function setActiveOrg(orgId: string): Promise<{ ok: boolean; error?: string }> {
  const user = await loadAuthUser();
  if (!user) return { ok: false, error: "auth_required" };
  const isMember = user.organizations.some((o) => o.organization_id === orgId);
  if (!isMember && !user.is_platform_admin) {
    return { ok: false, error: "forbidden" };
  }
  const store = await cookies();
  store.set("active_org", orgId, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  revalidatePath("/app", "layout");
  return { ok: true };
}
