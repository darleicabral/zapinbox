/**
 * scripts/setup-itaville-ai.ts — provisiona o AGENTE CLASSIFICADOR da Itaville
 * ("Customização 4": WhatsApp → chamado + IA pré-classifica). Idempotente.
 *
 * O agente é um CLASSIFICADOR SILENCIOSO: lê a mensagem, cria/atualiza o chamado
 * no pipeline "Chamados Pós-venda" e classifica (categoria/subcategoria/nível)
 * via a tool crm_save_lead_profile, depois encaminha pro humano. **Nunca responde
 * ao cliente** — garantido por código no runtime (trigger_config.reply_mode='silent').
 *
 * O que faz (idempotente):
 *   1. Acha a org itaville.
 *   2. Resolve a credencial Anthropic (org itaville, ativa E validada).
 *   3. Resolve a sessão WAHA (status='working') — por nome (ITAVILLE_WAHA_SESSION)
 *      ou a única working da org.
 *   4. Garante o ai_agents (kind='mcp_agent') "Triagem Pós-venda".
 *   5. Cria uma NOVA versão (draft) lendo o prompt de scripts/prompts/itaville-triagem.md.
 *   6. Publica via RPC fn_publish_ai_agent_version (supersede a anterior).
 *
 * Rodar de novo republica o prompt atualizado (nova versão) sem duplicar o agente.
 *
 * Uso:
 *   npx tsx scripts/setup-itaville-ai.ts
 *
 * Vars de ambiente:
 *   NEXT_PUBLIC_SUPABASE_URL       (obrigatória)
 *   SUPABASE_SERVICE_ROLE_KEY      (obrigatória — service role, bypassa RLS)
 *   ITAVILLE_WAHA_SESSION          (opcional — nome da sessão WAHA; senão auto-pick working)
 *   ITAVILLE_PROMPT_FILE           (opcional — default scripts/prompts/itaville-triagem.md)
 */

import { createClient } from "@supabase/supabase-js";
import * as fs from "node:fs";
import * as path from "node:path";

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
if (!SUPABASE_URL || !SERVICE_ROLE) {
  throw new Error("Faltam NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.");
}

const ORG_SLUG = "itaville";
const AGENT_NAME = "Triagem Pós-venda";
const PROVIDER = "anthropic";
const MODEL = "claude-haiku-4-5"; // catálogo ai_models (0023); cheap/fast p/ classificação
const TOOL_IDS = ["crm_save_lead_profile"]; // handoff é auto-injetado por handoff_tool_enabled
const PROMPT_FILE =
  env.ITAVILLE_PROMPT_FILE || path.join("scripts", "prompts", "itaville-triagem.md");

// reply_mode:'silent' → o runtime NUNCA envia resposta ao cliente (garantia por código).
const TRIGGER_CONFIG = {
  events: ["message"],
  filters: { ignore_groups: true, ignore_self: true, keyword_regex: null, business_hours: null },
  concurrency: "one_per_conversation",
  reply_mode: "silent",
};

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function die(msg: string): never {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  // 1) Org itaville.
  const { data: org } = await admin
    .from("organizations")
    .select("id, created_by")
    .eq("slug", ORG_SLUG)
    .maybeSingle<{ id: string; created_by: string | null }>();
  if (!org) die(`org "${ORG_SLUG}" não encontrada. Rode antes: npx tsx scripts/seed-itaville.ts`);
  const orgId = org!.id;
  console.log(`[org] itaville = ${orgId}`);

  // created_by = admin da org (fallback: org.created_by).
  const { data: adminMember } = await admin
    .from("user_organizations")
    .select("user_id")
    .eq("organization_id", orgId)
    .eq("role", "admin")
    .is("revoked_at", null)
    .order("accepted_at", { ascending: true })
    .limit(1)
    .maybeSingle<{ user_id: string }>();
  const createdBy = adminMember?.user_id ?? org!.created_by ?? null;

  // 2) Credencial Anthropic (ativa E validada — a publish fn exige validated_at).
  const { data: cred } = await admin
    .from("ai_provider_credentials")
    .select("id, label, is_active, validated_at")
    .eq("organization_id", orgId)
    .eq("provider", PROVIDER)
    .eq("is_active", true)
    .not("validated_at", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string; label: string; is_active: boolean; validated_at: string | null }>();
  if (!cred) {
    die(
      `nenhuma credencial ${PROVIDER} ATIVA e VALIDADA na org itaville.\n` +
        `   → No CRM (logado como admin da Itaville): Configurações → Agentes IA → Credenciais,\n` +
        `     adicione a chave da Anthropic e clique em Validar. Depois rode este script de novo.`,
    );
  }
  console.log(`[cred] ${PROVIDER} = ${cred!.id} ("${cred!.label}")`);

  // 3) Sessão WAHA working.
  let sessionQuery = admin
    .from("channel_sessions")
    .select("id, waha_session_name, status")
    .eq("organization_id", orgId)
    .eq("status", "working");
  if (env.ITAVILLE_WAHA_SESSION) {
    sessionQuery = sessionQuery.eq("waha_session_name", env.ITAVILLE_WAHA_SESSION);
  }
  const { data: sessions } = await sessionQuery;
  const sessionList = sessions ?? [];
  if (sessionList.length === 0) {
    die(
      `nenhuma sessão WhatsApp com status 'working' na org itaville` +
        (env.ITAVILLE_WAHA_SESSION ? ` (nome "${env.ITAVILLE_WAHA_SESSION}")` : "") +
        `.\n   → Pareie o número no CRM: Conexões → conectar/QR. A sessão precisa ficar 'working'.`,
    );
  }
  if (sessionList.length > 1 && !env.ITAVILLE_WAHA_SESSION) {
    die(
      `há ${sessionList.length} sessões 'working' na org. Especifique qual com\n` +
        `   ITAVILLE_WAHA_SESSION=<nome> (opções: ${sessionList
          .map((s) => (s as { waha_session_name: string }).waha_session_name)
          .join(", ")}).`,
    );
  }
  const session = sessionList[0] as { id: string; waha_session_name: string };
  console.log(`[waha] sessão = ${session.id} ("${session.waha_session_name}", working)`);

  // 4) Prompt.
  const promptPath = path.isAbsolute(PROMPT_FILE) ? PROMPT_FILE : path.join(process.cwd(), PROMPT_FILE);
  if (!fs.existsSync(promptPath)) die(`prompt não encontrado: ${promptPath}`);
  const systemPrompt = fs.readFileSync(promptPath, "utf8").trim();
  if (systemPrompt.length < 50) die(`prompt vazio/curto demais: ${promptPath}`);
  console.log(`[prompt] ${promptPath} (${systemPrompt.length} chars)`);

  // 5) Garante o ai_agents (mcp_agent) "Triagem Pós-venda".
  const { data: existingAgent } = await admin
    .from("ai_agents")
    .select("id")
    .eq("organization_id", orgId)
    .eq("name", AGENT_NAME)
    .is("archived_at", null)
    .maybeSingle<{ id: string }>();

  let agentId: string;
  if (existingAgent) {
    agentId = existingAgent.id;
    await admin
      .from("ai_agents")
      .update({ model: `${PROVIDER}/${MODEL}`, system_prompt: systemPrompt })
      .eq("id", agentId);
    console.log(`[agent] reutilizado: ${agentId}`);
  } else {
    const { data: created, error: agentErr } = await admin
      .from("ai_agents")
      .insert({
        organization_id: orgId,
        name: AGENT_NAME,
        description: "Classificador silencioso de chamados de pós-venda (WhatsApp → chamado).",
        model: `${PROVIDER}/${MODEL}`,
        system_prompt: systemPrompt,
        is_active: true,
        is_default: false,
        kind: "mcp_agent",
        priority: 0,
        created_by: createdBy,
      } as never)
      .select("id")
      .single<{ id: string }>();
    if (agentErr || !created) die(`criar agent: ${agentErr?.message}`);
    agentId = created!.id;
    console.log(`[agent] criado: ${agentId}`);
  }

  // 6) Nova versão (draft) = max(version_number)+1.
  const { data: lastVer } = await admin
    .from("ai_agent_versions")
    .select("version_number")
    .eq("agent_id", agentId)
    .order("version_number", { ascending: false })
    .limit(1)
    .maybeSingle<{ version_number: number }>();
  const nextVersion = (lastVer?.version_number ?? 0) + 1;

  const { data: versionRow, error: verErr } = await admin
    .from("ai_agent_versions")
    .insert({
      organization_id: orgId,
      agent_id: agentId,
      version_number: nextVersion,
      system_prompt: systemPrompt,
      provider: PROVIDER,
      model: MODEL,
      credential_id: cred!.id,
      tool_ids: TOOL_IDS,
      trigger_config: TRIGGER_CONFIG,
      channel_session_id: session.id,
      max_steps: 6,
      token_budget: 50000,
      cost_budget_cents: 50,
      history_message_window: 20,
      history_token_window: 8000,
      handoff_keywords: [], // vazio de propósito: sem short-circuit; queremos classificar ANTES do handoff
      handoff_tool_enabled: true,
      status: "draft",
      created_by: createdBy,
    } as never)
    .select("id, version_number")
    .single<{ id: string; version_number: number }>();
  if (verErr || !versionRow) die(`criar versão: ${verErr?.message}`);
  console.log(`[version] draft v${versionRow!.version_number} = ${versionRow!.id}`);

  // 7) Publica (atômico; supersede a anterior; valida credencial/sessão/modelo).
  const { data: pub, error: pubErr } = await admin.rpc("fn_publish_ai_agent_version" as never, {
    p_org_id: orgId,
    p_agent_id: agentId,
    p_version_id: versionRow!.id,
  } as never);
  if (pubErr) {
    die(
      `publish falhou: ${pubErr.message}\n` +
        `   (motivos comuns: sessão não 'working', credencial não validada, modelo fora do catálogo).`,
    );
  }

  console.log("\n✅ Agente classificador da Itaville publicado.");
  console.log("──────────────────────────────────────────────");
  console.log(`  org:        ${orgId}`);
  console.log(`  agent:      ${agentId} ("${AGENT_NAME}", mcp_agent)`);
  console.log(`  version:    ${versionRow!.id} (v${versionRow!.version_number}, published)`);
  console.log(`  modelo:     ${PROVIDER}/${MODEL}`);
  console.log(`  sessão:     ${session.waha_session_name}`);
  console.log(`  modo:       SILENCIOSO (não responde ao cliente) + classifica + handoff`);
  console.log("──────────────────────────────────────────────");
  console.log("  Teste: mande um WhatsApp pro número pareado → deve aparecer um chamado");
  console.log("  novo em 'Chamados Pós-venda' (etapa Novo), já classificado, SEM resposta ao cliente.");
  console.log(JSON.stringify(pub));
}

main().catch((err) => {
  console.error("❌ setup-itaville-ai falhou:", err);
  process.exit(1);
});
