import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";
const env = fs.readFileSync(".env.local", "utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)![1].trim();
const key = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)![1].trim();
const sb = createClient(url, key, { auth: { persistSession: false } });
const creds = JSON.parse(fs.readFileSync(".e2e-creds.json", "utf8"));
(async () => {
  for (const u of Object.values(creds.users) as Array<{ id: string; email: string }>) {
    const { data } = await sb
      .from("user_organizations")
      .select("user_id, organization_id, role")
      .eq("user_id", u.id);
    console.log(u.email, "→", JSON.stringify(data));
  }
})();
