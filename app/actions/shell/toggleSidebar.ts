"use server";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";

export async function toggleSidebar(currentlyCollapsed: boolean): Promise<void> {
  const store = await cookies();
  store.set("sidebar_collapsed", currentlyCollapsed ? "0" : "1", {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  revalidatePath("/app", "layout");
}
