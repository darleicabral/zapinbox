/**
 * Seed E2E test credentials: 1 org + 3 users (admin, manager, agent) + 1 ai_agents default.
 * Idempotent: re-runs upsert by email/org name.
 *
 * Output: .e2e-creds.json (gitignored) com URLs e creds para Playwright/curl.
 *
 * Run: npx tsx scripts/seed-e2e-credentials.ts
 */

import { createClient } from "@supabase/supabase-js";
import * as fs from "node:fs";
import * as path from "node:path";

// Carrega .env.local manualmente (sem next/env aqui).
const envFile = fs.readFileSync(path.join(process.cwd(), ".env.local"), "utf8");
const env: Record<string, string> = {};
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]!] = m[2]!.replace(/^"(.*)"$/, "$1");
}

const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE = env.SUPABASE_SERVICE_ROLE_KEY!;
if (!SUPABASE_URL || !SERVICE_ROLE) {
  throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const ORG_NAME = "E2E Test Org";
const ORG_SLUG = "e2e-test-org";
const PASSWORD = "E2E!Test1234";

const USERS: Array<{ email: string; role: "admin" | "manager" | "agent"; full_name: string }> = [
  { email: "e2e-admin@deskcomm.test", role: "admin", full_name: "E2E Admin" },
  { email: "e2e-manager@deskcomm.test", role: "manager", full_name: "E2E Manager" },
  { email: "e2e-agent@deskcomm.test", role: "agent", full_name: "E2E Agent" },
];

async function ensureOrg(): Promise<string> {
  const { data: existing } = await admin
    .from("organizations")
    .select("id")
    .eq("slug", ORG_SLUG)
    .maybeSingle();
  if (existing) {
    console.log(`[seed] org existing: ${(existing as { id: string }).id}`);
    return (existing as { id: string }).id;
  }
  const { data, error } = await admin
    .from("organizations")
    .insert({
      slug: ORG_SLUG,
      display_name: ORG_NAME,
      legal_name: ORG_NAME,
      timezone: "America/Sao_Paulo",
      locale: "pt-BR",
      onboarded_at: new Date().toISOString(),
    } as never)
    .select("id")
    .single();
  if (error || !data) throw new Error("create org: " + error?.message);
  const orgId = (data as { id: string }).id;
  console.log(`[seed] org created: ${orgId}`);
  return orgId;
}

async function ensureUser(email: string, full_name: string): Promise<string> {
  // listUsers paginado — perPage default 50; nosso pool é pequeno
  const { data: list } = await admin.auth.admin.listUsers({ perPage: 200 });
  const existing = list.users.find((u) => u.email === email);
  if (existing) {
    console.log(`[seed] user existing ${email}: ${existing.id}`);
    // garantir senha conhecida
    await admin.auth.admin.updateUserById(existing.id, { password: PASSWORD });
    return existing.id;
  }
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { full_name },
  });
  if (error || !data?.user) throw new Error(`create user ${email}: ${error?.message}`);
  console.log(`[seed] user created ${email}: ${data.user.id}`);
  return data.user.id;
}

async function ensureMembership(userId: string, orgId: string, role: string): Promise<void> {
  const { data: existing } = await admin
    .from("user_organizations")
    .select("user_id")
    .eq("user_id", userId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (existing) {
    await admin
      .from("user_organizations")
      .update({ role, revoked_at: null } as never)
      .eq("user_id", userId)
      .eq("organization_id", orgId);
    console.log(`[seed] membership updated user=${userId} role=${role}`);
    return;
  }
  const { error } = await admin.from("user_organizations").insert({
    user_id: userId,
    organization_id: orgId,
    role,
    accepted_at: new Date().toISOString(),
  } as never);
  if (error) throw new Error(`membership insert: ${error.message}`);
  console.log(`[seed] membership inserted user=${userId} role=${role}`);
}

async function ensureAgent(orgId: string): Promise<string> {
  const { data: existing } = await admin
    .from("ai_agents")
    .select("id")
    .eq("organization_id", orgId)
    .eq("is_default", true)
    .maybeSingle();
  if (existing) {
    console.log(`[seed] ai_agent default existing: ${(existing as { id: string }).id}`);
    return (existing as { id: string }).id;
  }
  const { data, error } = await admin
    .from("ai_agents")
    .insert({
      organization_id: orgId,
      name: "Bot Padrão E2E",
      description: "Agent default para testes E2E",
      is_active: true,
      is_default: true,
      model: "anthropic/claude-sonnet-4-6",
      system_prompt:
        "Você é um assistente do CRM E2E. Responda de forma educada e use os {rag_chunks} disponíveis.",
      config: {
        temperature: 0.4,
        max_tokens: 1024,
        context_message_window: 20,
        rag_top_k: 5,
        rag_similarity_threshold: 0.72,
        confidence_threshold: 0.6,
      },
      guardrails: [],
    } as never)
    .select("id")
    .single();
  if (error || !data) throw new Error("ai_agent insert: " + error?.message);
  const id = (data as { id: string }).id;
  console.log(`[seed] ai_agent default created: ${id}`);
  return id;
}

async function main(): Promise<void> {
  const orgId = await ensureOrg();

  const users: Record<string, { id: string; email: string; role: string }> = {};
  for (const u of USERS) {
    const userId = await ensureUser(u.email, u.full_name);
    await ensureMembership(userId, orgId, u.role);
    users[u.role] = { id: userId, email: u.email, role: u.role };
  }

  const agentId = await ensureAgent(orgId);

  const creds = {
    org_id: orgId,
    org_slug: ORG_SLUG,
    org_name: ORG_NAME,
    password: PASSWORD,
    users,
    default_agent_id: agentId,
    app_url: env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",
    supabase_url: SUPABASE_URL,
    supabase_anon_key: env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
  };

  fs.writeFileSync(".e2e-creds.json", JSON.stringify(creds, null, 2));
  console.log("\n✅ Seed completo. Credenciais escritas em .e2e-creds.json");
  console.log(`org: ${orgId}`);
  console.log(`agent default: ${agentId}`);
  console.log(`users: ${Object.values(users).map((u) => `${u.role}=${u.email}`).join(", ")}`);
}

main().catch((err) => {
  console.error("❌ Seed falhou:", err);
  process.exit(1);
});
