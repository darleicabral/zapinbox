/**
 * scripts/seed-tenant.ts — cria um tenant (organization) via CLI, de forma
 * idempotente. Substitui o placeholder original; segue o padrão do
 * bootstrap-owner.ts (env vars + loadEnv de .env/.env.local).
 *
 * O que faz:
 *   1. Cria a organization (o trigger trg_seed_default_pipeline_for_org
 *      seeda o pipeline default "Pedidos" automaticamente)
 *   2. Associa um usuário JÁ EXISTENTE como admin do tenant
 *   3. (opcional) TENANT_PROFILE=imobiliaria — remodela o pipeline default
 *      para etapas de negociação imobiliária (só na criação; não mexe em
 *      pipeline de org que já existia)
 *
 * Uso:
 *   TENANT_NAME='Avant Negócios Imobiliários' \
 *   TENANT_ADMIN_EMAIL=admin@empresa.com \
 *   TENANT_PROFILE=imobiliaria \
 *   npx tsx scripts/seed-tenant.ts
 *
 * Vars opcionais: TENANT_SLUG (default: slug do nome), TENANT_CNPJ.
 */

import { createClient } from "@supabase/supabase-js";
import * as fs from "node:fs";
import * as path from "node:path";

/** Lê env do processo; completa com .env / .env.local se rodando localmente. */
function loadEnv(): Record<string, string> {
  const out: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const file of [".env", ".env.local"]) {
    const p = path.join(process.cwd(), file);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !out[m[1]!]) out[m[1]!] = m[2]!.replace(/^"(.*)"$/, "$1");
    }
  }
  return out;
}

const env = loadEnv();

const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE = env.SUPABASE_SERVICE_ROLE_KEY;
const TENANT_NAME = env.TENANT_NAME;
const TENANT_ADMIN_EMAIL = env.TENANT_ADMIN_EMAIL;
const TENANT_CNPJ = env.TENANT_CNPJ || null;
const TENANT_PROFILE = env.TENANT_PROFILE || "";

if (!SUPABASE_URL || !SERVICE_ROLE) {
  throw new Error("Faltam NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.");
}
if (!TENANT_NAME || !TENANT_ADMIN_EMAIL) {
  throw new Error("Faltam TENANT_NAME / TENANT_ADMIN_EMAIL.");
}

/** slug seguro: minúsculo, hífens, sem acento (coluna organizations.slug é citext restrito). */
function slugify(s: string): string {
  return (
    s
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "tenant"
  );
}

const TENANT_SLUG = env.TENANT_SLUG || slugify(TENANT_NAME);

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function findAdminUser(): Promise<string> {
  const { data: list, error } = await admin.auth.admin.listUsers({ perPage: 200 });
  if (error) throw new Error(`listar usuários: ${error.message}`);
  const user = list.users.find((u) => u.email === TENANT_ADMIN_EMAIL);
  if (!user) {
    throw new Error(
      `Usuário ${TENANT_ADMIN_EMAIL} não existe no auth. Crie-o antes ` +
        `(bootstrap-owner.ts ou convite pela UI) — este script não cria usuários.`,
    );
  }
  return user.id;
}

/** Cria a org; retorna { id, created } — created=false se o slug já existia. */
async function ensureOrg(adminUserId: string): Promise<{ id: string; created: boolean }> {
  const { data: existing } = await admin
    .from("organizations")
    .select("id")
    .eq("slug", TENANT_SLUG)
    .maybeSingle();
  if (existing) {
    console.log(`[seed-tenant] org já existia (slug=${TENANT_SLUG}): ${(existing as { id: string }).id}`);
    return { id: (existing as { id: string }).id, created: false };
  }
  const { data, error } = await admin
    .from("organizations")
    .insert({
      slug: TENANT_SLUG,
      display_name: TENANT_NAME,
      legal_name: TENANT_NAME,
      cnpj: TENANT_CNPJ,
      created_by: adminUserId,
    } as never)
    .select("id")
    .single();
  if (error || !data) throw new Error(`criar org: ${error?.message}`);
  const id = (data as { id: string }).id;
  console.log(`[seed-tenant] org criada: ${id} (slug=${TENANT_SLUG})`);
  return { id, created: true };
}

async function ensureMembership(userId: string, orgId: string): Promise<void> {
  const { data: existing } = await admin
    .from("user_organizations")
    .select("user_id")
    .eq("user_id", userId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (existing) {
    await admin
      .from("user_organizations")
      .update({ role: "admin", revoked_at: null } as never)
      .eq("user_id", userId)
      .eq("organization_id", orgId);
    console.log("[seed-tenant] associação admin garantida");
    return;
  }
  const { error } = await admin.from("user_organizations").insert({
    user_id: userId,
    organization_id: orgId,
    role: "admin",
    accepted_at: new Date().toISOString(),
  } as never);
  if (error) throw new Error(`associação: ${error.message}`);
  console.log(`[seed-tenant] ${TENANT_ADMIN_EMAIL} associado como admin`);
}

/**
 * Remodela o pipeline default seedado pelo trigger (e-commerce "Pedidos")
 * para o perfil imobiliário. Só roda quando a org acabou de ser criada,
 * então não há leads apontando para as stages antigas.
 */
async function applyImobiliariaProfile(orgId: string): Promise<void> {
  const { data: pipeline, error: pErr } = await admin
    .from("crm_pipelines")
    .select("id")
    .eq("organization_id", orgId)
    .eq("is_default", true)
    .single();
  if (pErr || !pipeline) throw new Error(`pipeline default não encontrado: ${pErr?.message}`);
  const pipelineId = (pipeline as { id: string }).id;

  const { error: upErr } = await admin
    .from("crm_pipelines")
    .update({
      name: "Negociações",
      slug: "negociacoes",
      vocabulary: {
        lead: "Lead",
        lead_plural: "Leads",
        deal: "Negociação",
        deal_plural: "Negociações",
        won: "Fechado",
        lost: "Perdido",
        stage: "Etapa",
        stage_plural: "Etapas",
      },
    } as never)
    .eq("id", pipelineId);
  if (upErr) throw new Error(`renomear pipeline: ${upErr.message}`);

  const { error: delErr } = await admin
    .from("crm_stages")
    .delete()
    .eq("pipeline_id", pipelineId);
  if (delErr) throw new Error(`limpar stages seed: ${delErr.message}`);

  const stages: Array<[string, string, boolean, boolean]> = [
    ["Novo lead", "novo_lead", false, false],
    ["Em atendimento", "em_atendimento", false, false],
    ["Visita agendada", "visita_agendada", false, false],
    ["Proposta", "proposta", false, false],
    ["Fechado", "fechado", true, false],
    ["Perdido", "perdido", false, true],
  ];
  let position = 1000;
  for (const [name, slug, isWon, isLost] of stages) {
    const { error } = await admin.from("crm_stages").insert({
      organization_id: orgId,
      pipeline_id: pipelineId,
      name,
      slug,
      position,
      is_won: isWon,
      is_lost: isLost,
    } as never);
    if (error) throw new Error(`stage ${slug}: ${error.message}`);
    position += 1000;
  }
  console.log("[seed-tenant] pipeline remodelado p/ perfil imobiliária (Negociações, 6 etapas)");
}

async function main(): Promise<void> {
  const adminUserId = await findAdminUser();
  const { id: orgId, created } = await ensureOrg(adminUserId);
  await ensureMembership(adminUserId, orgId);
  if (created && TENANT_PROFILE === "imobiliaria") {
    await applyImobiliariaProfile(orgId);
  } else if (!created && TENANT_PROFILE) {
    console.log("[seed-tenant] org já existia — perfil de pipeline NÃO reaplicado (proteção)");
  }
  console.log(
    `\n✅ Tenant pronto.\n  org:   ${orgId} (slug=${TENANT_SLUG})\n  admin: ${TENANT_ADMIN_EMAIL}\n  Troque de organização no app para concluir o onboarding do tenant.`,
  );
}

main().catch((err) => {
  console.error("❌ seed-tenant falhou:", err);
  process.exit(1);
});
