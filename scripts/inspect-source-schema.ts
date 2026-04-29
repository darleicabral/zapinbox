import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";
const env = fs.readFileSync(".env.local", "utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)![1].trim();
const key = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)![1].trim();
const sb = createClient(url, key, { auth: { persistSession: false } });

(async () => {
  // 1. Read sample row to see all columns
  const { data: sample } = await sb.from("ai_knowledge_sources").select("*").limit(1);
  console.log("Sample row keys:", sample?.[0] ? Object.keys(sample[0]) : "no rows");
  console.log("Sample row:", JSON.stringify(sample?.[0], null, 2));

  // 2. Try inserting with various statuses to discover constraints
  const orgId = JSON.parse(fs.readFileSync(".e2e-creds.json", "utf8")).org_id;
  const agentId = JSON.parse(fs.readFileSync(".e2e-creds.json", "utf8")).default_agent_id;
  for (const candidate of ["ready", "pending", "indexing", "archived", "failed", "partial"]) {
    const { error } = await sb.from("ai_knowledge_sources").insert({
      organization_id: orgId, agent_id: agentId,
      source_type: "policy", name: `probe-${candidate}`,
      status: candidate,
    } as never);
    console.log(`status='${candidate}' →`, error ? `BLOCKED: ${error.message}` : "ACCEPTED");
    if (!error) {
      await sb.from("ai_knowledge_sources").delete().eq("name", `probe-${candidate}`).eq("organization_id", orgId);
    }
  }
  for (const candidate of [null, "ready", "pending", "indexing", "failed", "partial"]) {
    const { error } = await sb.from("ai_knowledge_sources").insert({
      organization_id: orgId, agent_id: agentId,
      source_type: "policy", name: `probe-lis-${candidate}`,
      status: "ready", last_index_status: candidate,
    } as never);
    console.log(`last_index_status='${candidate}' →`, error ? `BLOCKED: ${error.message}` : "ACCEPTED");
    if (!error) {
      await sb.from("ai_knowledge_sources").delete().eq("name", `probe-lis-${candidate}`).eq("organization_id", orgId);
    }
  }
})();
