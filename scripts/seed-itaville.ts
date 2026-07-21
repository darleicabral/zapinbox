/**
 * scripts/seed-itaville.ts — provisiona o tenant "Itaville" (chamados de
 * pós-venda de empreendimentos) de forma 100% idempotente, usando o
 * service-role client (bypassa RLS).
 *
 * O que faz (nesta ordem):
 *   1. Garante os usuários no Supabase Auth (email_confirm:true):
 *        - Darlei   (digitalmkt.gestao@gmail.com)  — admin
 *        - Samilis  (samilis.neves@itaville.com.br) — agent
 *      Reutiliza o id se o e-mail já existir; senão cria com senha de
 *      DARLEI_PASSWORD / SAMILIS_PASSWORD (ou aleatória, impressa no fim).
 *   2. Garante a organization "itaville" (created_by=Darlei, onboarded_at=now
 *      para pular o wizard). O trigger trg_seed_default_pipeline_for_org cria
 *      o pipeline default automaticamente.
 *   3. Garante os memberships em user_organizations (Darlei=admin, Samilis=agent).
 *   4. Remodela o pipeline default para os CHAMADOS pós-venda: renomeia,
 *      define vocabulary/settings.fields e recria as 5 stages. Isso só é feito
 *      com segurança quando ainda não há chamados (crm_leads) no pipeline.
 *
 * Uso:
 *   npx tsx scripts/seed-itaville.ts
 *
 * Vars de ambiente:
 *   NEXT_PUBLIC_SUPABASE_URL       (obrigatória)
 *   SUPABASE_SERVICE_ROLE_KEY      (obrigatória — service role, bypassa RLS)
 *   DARLEI_PASSWORD                (opcional — senha do Darlei se for criado)
 *   SAMILIS_PASSWORD               (opcional — senha da Samilis; se ausente, gera aleatória)
 *   NEXT_PUBLIC_APP_URL            (opcional — só para imprimir a URL do CRM)
 *
 * Rodar de novo NÃO duplica nada.
 */

import { createClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
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
const APP_URL = env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

if (!SUPABASE_URL || !SERVICE_ROLE) {
  throw new Error("Faltam NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.");
}

// ── Constantes do tenant ────────────────────────────────────────────────────
const ORG_SLUG = "itaville";
const ORG_NAME = "Itaville";

const DARLEI_EMAIL = "digitalmkt.gestao@gmail.com";
const SAMILIS_EMAIL = "samilis.neves@itaville.com.br";

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ── Fields do pipeline de chamados (settings.fields) ────────────────────────
type Opt = { value: string; label: string };
type Field = (
  | { key: string; label: string; type: "text" | "textarea" | "date" }
  | { key: string; label: string; type: "select"; options: Opt[] }
  | { key: string; label: string; type: "select"; optionsBy: { field: string; map: Record<string, Opt[]> } }
) & {
  /** Campo de acompanhamento: some do diálogo de criação (só edição). */
  hideOnCreate?: boolean;
};

/** helper: select cujo options tem value === label */
const sel = (key: string, label: string, options: string[]): Field => ({
  key,
  label,
  type: "select",
  options: options.map((o) => ({ value: o, label: o })),
});
/** select dependente: options vêm de map[valor do campo pai]. */
const selDep = (
  key: string,
  label: string,
  field: string,
  map: Record<string, string[]>,
): Field => ({
  key,
  label,
  type: "select",
  optionsBy: {
    field,
    map: Object.fromEntries(
      Object.entries(map).map(([k, v]) => [k, v.map((o) => ({ value: o, label: o }))]),
    ),
  },
});
const txt = (key: string, label: string): Field => ({ key, label, type: "text" });
const dat = (key: string, label: string): Field => ({ key, label, type: "date" });
const area = (key: string, label: string): Field => ({ key, label, type: "textarea" });

/** Categoria → subcategorias (§3 da spec 06). */
const SUBCATEGORIAS: Record<string, string[]> = {
  Financeiro: ["boleto", "2ª via de boleto", "vencimento", "comprovante", "negociação", "parcela", "reajuste", "multa por atraso"],
  "Contrato e documentação": ["2ª via de contrato", "assinatura", "aditivo", "escritura", "documentos"],
  "Obra e entrega": ["andamento", "cronograma", "motivo do atraso", "nova previsão de entrega", "visita à obra", "entrega de chaves"],
  "Distrato e rescisão": ["intenção de distrato", "cálculo de multa/devolução", "condições de distrato"],
  "Assistência técnica": ["vistoria", "reparo", "garantia", "infiltração", "elétrica", "hidráulica", "acabamento (AT)"],
  "Personalização e unidade": ["alteração de planta", "acabamento (personalização)", "dúvidas de unidade", "medição"],
  "Empreendimento e condomínio": ["áreas comuns", "vaga", "taxa condominial", "regulamento", "administração"],
  Relacionamento: ["reclamação", "elogio", "sugestão", "solicitação especial", "retorno de contato"],
  Jurídico: ["ameaça de ação judicial", "Procon", "advogado constituído", "notificação", "disputa contratual"],
};

const FIELDS: Field[] = [
  sel("empreendimento", "Empreendimento", ["Salvador Dalí", "Van Gogh", "Jardim Canaã"]),
  txt("unidade", "Unidade"),
  txt("interlocutor", "Interlocutor (quem falou)"),
  sel("interlocutor_relacao", "Relação com o titular", [
    "Próprio titular",
    "Cônjuge",
    "Parente",
    "Representante",
    "Advogado",
  ]),
  // Todos os titulares no exterior são dos EUA — sem campo de país (decisão 21/07).
  sel("titular_exterior", "Titular no exterior?", ["Sim", "Não"]),
  sel("canal", "Canal", ["WhatsApp", "Telefone", "E-mail", "Presencial"]),
  sel("categoria", "Categoria", [
    "Financeiro",
    "Contrato e documentação",
    "Obra e entrega",
    "Distrato e rescisão",
    "Assistência técnica",
    "Personalização e unidade",
    "Empreendimento e condomínio",
    "Relacionamento",
    "Jurídico",
  ]),
  selDep("subcategoria", "Subcategoria", "categoria", SUBCATEGORIAS),
  sel("nivel_acompanhamento", "Nível de acompanhamento", ["Verde", "Amarelo", "Vermelho"]),
  sel("responsavel_area", "Responsável (área)", ["Relacionamento", "Financeiro", "Obra/AT", "Jurídico"]),
  { ...dat("proximo_contato", "Próximo contato"), hideOnCreate: true },
  area("observacoes", "Observações"),
  sel("vg_impacto_previsao", "VG · Impacto da nova previsão", [
    "Sem impacto",
    "Leve",
    "Relevante",
    "Aguardando conversa",
  ]),
  sel("vg_tipo_impacto", "VG · Tipo de impacto", [
    "Mudança",
    "Aluguel",
    "Viagem",
    "Financiamento",
    "Investimento",
    "Outro",
  ]),
  { ...sel("vg_contrapartida", "VG · Contrapartida comunicada", ["Sim", "Não"]), hideOnCreate: true },
  { ...sel("vg_material_enviado", "VG · Material enviado", ["Sim", "Não"]), hideOnCreate: true },
];

const VOCABULARY = {
  lead: "Chamado",
  lead_plural: "Chamados",
  deal: "Chamado",
  deal_plural: "Chamados",
  won: "Concluído",
  lost: "Cancelado",
  stage: "Status",
  stage_plural: "Status",
};

// [name, slug, position, color, is_won, is_lost] — exatamente 1 won e 1 lost.
const STAGES: Array<[string, string, number, string, boolean, boolean]> = [
  ["Aberto", "aberto", 1000, "#3B82F6", false, false],
  ["Em andamento", "em_andamento", 2000, "#F59E0B", false, false],
  ["Aguardando cliente", "aguardando_cliente", 3000, "#A855F7", false, false],
  ["Concluído", "concluido", 4000, "#22C55E", true, false],
  ["Cancelado", "cancelado", 5000, "#EF4444", false, true],
];

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Senha aleatória forte (letras+dígitos + garantia de complexidade). */
function genPassword(): string {
  const body = randomBytes(15).toString("base64url").replace(/[^A-Za-z0-9]/g, "");
  return `Zx${body}9!`;
}

/** Procura usuário por e-mail paginando o Admin API (robusto p/ >1000 users). */
async function findUserByEmail(email: string): Promise<{ id: string } | null> {
  const target = email.toLowerCase();
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`listar usuários: ${error.message}`);
    const u = data.users.find((x) => (x.email ?? "").toLowerCase() === target);
    if (u) return { id: u.id };
    if (data.users.length < 1000) return null;
  }
}

/**
 * Garante um usuário no auth. Reutiliza o id se já existir.
 * - explicitPassword definido: aplica a senha (create ou update) — determinístico/idempotente.
 * - sem explicitPassword: se criar, gera aleatória; se já existia, não mexe na senha.
 * Retorna a senha aplicada (ou null quando não foi tocada).
 */
async function ensureAuthUser(
  email: string,
  explicitPassword: string | undefined,
  fullName: string,
): Promise<{ id: string; created: boolean; password: string | null }> {
  const existing = await findUserByEmail(email);
  if (existing) {
    if (explicitPassword) {
      const { error } = await admin.auth.admin.updateUserById(existing.id, {
        password: explicitPassword,
        email_confirm: true,
      });
      if (error) throw new Error(`atualizar ${email}: ${error.message}`);
      console.log(`[user] ${email} já existia — id reutilizado, senha (env) aplicada: ${existing.id}`);
      return { id: existing.id, created: false, password: explicitPassword };
    }
    console.log(`[user] ${email} já existia — id reutilizado, senha inalterada: ${existing.id}`);
    return { id: existing.id, created: false, password: null };
  }

  const password = explicitPassword ?? genPassword();
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });
  if (error || !data?.user) throw new Error(`criar ${email}: ${error?.message ?? "sem user"}`);
  console.log(`[user] ${email} criado: ${data.user.id}`);
  return { id: data.user.id, created: true, password };
}

/** Cria/garante a org; garante onboarded_at populado. */
async function ensureOrg(createdBy: string): Promise<{ id: string; created: boolean }> {
  const { data: existing } = await admin
    .from("organizations")
    .select("id, onboarded_at")
    .eq("slug", ORG_SLUG)
    .maybeSingle<{ id: string; onboarded_at: string | null }>();

  if (existing) {
    if (!existing.onboarded_at) {
      await admin
        .from("organizations")
        .update({ onboarded_at: new Date().toISOString() } as never)
        .eq("id", existing.id);
      console.log(`[org] já existia — onboarded_at populado: ${existing.id}`);
    } else {
      console.log(`[org] já existia (onboarded): ${existing.id}`);
    }
    return { id: existing.id, created: false };
  }

  const { data, error } = await admin
    .from("organizations")
    .insert({
      slug: ORG_SLUG,
      display_name: ORG_NAME,
      legal_name: ORG_NAME,
      created_by: createdBy,
      onboarded_at: new Date().toISOString(),
    } as never)
    .select("id")
    .single<{ id: string }>();
  if (error || !data) throw new Error(`criar org: ${error?.message}`);
  console.log(`[org] criada: ${data.id} (slug=${ORG_SLUG})`);
  return { id: data.id, created: true };
}

/** Garante o membership com o papel desejado (accepted_at=now, revoked_at=null). */
async function ensureMembership(userId: string, orgId: string, role: "admin" | "agent"): Promise<void> {
  const { data: existing } = await admin
    .from("user_organizations")
    .select("id")
    .eq("user_id", userId)
    .eq("organization_id", orgId)
    .maybeSingle<{ id: string }>();

  if (existing) {
    const { error } = await admin
      .from("user_organizations")
      .update({ role, revoked_at: null, accepted_at: new Date().toISOString() } as never)
      .eq("id", existing.id);
    if (error) throw new Error(`membership ${role}: ${error.message}`);
    console.log(`[membership] atualizado → ${role} (user=${userId})`);
    return;
  }

  const { error } = await admin.from("user_organizations").insert({
    user_id: userId,
    organization_id: orgId,
    role,
    accepted_at: new Date().toISOString(),
  } as never);
  if (error) throw new Error(`membership ${role}: ${error.message}`);
  console.log(`[membership] inserido → ${role} (user=${userId})`);
}

/**
 * Remodela o pipeline default (o que o trigger criou) para os chamados.
 * - UPDATE de name/slug/vocabulary/settings sempre roda (idempotente).
 * - Recria as stages apenas quando não há chamados (crm_leads) apontando p/ o
 *   pipeline — evita violar a FK RESTRICT de crm_leads.stage_id. Se já houver
 *   chamados e as 5 stages já existirem, considera remodelado e segue.
 */
async function remodelPipeline(orgId: string): Promise<string> {
  const { data: pipeline, error: pErr } = await admin
    .from("crm_pipelines")
    .select("id, settings")
    .eq("organization_id", orgId)
    .eq("is_default", true)
    .single<{ id: string; settings: Record<string, unknown> }>();
  if (pErr || !pipeline) throw new Error(`pipeline default não encontrado: ${pErr?.message}`);
  const pipelineId = pipeline.id;

  // Preserva canonical_tags / lost_reasons / identity_resolution; troca fields.
  const prev = (pipeline.settings ?? {}) as Record<string, unknown>;
  const newSettings = {
    ...prev,
    canonical_tags: prev.canonical_tags ?? [],
    lost_reasons: prev.lost_reasons ?? [],
    identity_resolution:
      prev.identity_resolution ?? { fields_in_priority_order: ["cpf", "phone_e164", "email"] },
    fields: FIELDS,
    // Chamado de pós-venda não tem valor de negócio nem data de fechamento —
    // esconde os campos de venda embutidos nos diálogos (ver form_hide na UI).
    form_hide: ["value", "expected_close_date"],
  };

  const { error: upErr } = await admin
    .from("crm_pipelines")
    .update({
      name: "Chamados Pós-venda",
      slug: "chamados-pos-venda",
      vocabulary: VOCABULARY,
      settings: newSettings,
    } as never)
    .eq("id", pipelineId);
  if (upErr) throw new Error(`atualizar pipeline: ${upErr.message}`);
  console.log(`[pipeline] ${pipelineId} → "Chamados Pós-venda" (vocabulary + ${FIELDS.length} fields)`);

  // Só recria as stages se ainda não houver chamados no pipeline.
  const { count, error: cErr } = await admin
    .from("crm_leads")
    .select("id", { count: "exact", head: true })
    .eq("pipeline_id", pipelineId);
  if (cErr) throw new Error(`contar chamados: ${cErr.message}`);

  if ((count ?? 0) > 0) {
    console.log(
      `[pipeline] já há ${count} chamado(s) — stages NÃO recriadas (proteção FK). ` +
        `Ajuste manualmente se precisar.`,
    );
    return pipelineId;
  }

  const { error: delErr } = await admin.from("crm_stages").delete().eq("pipeline_id", pipelineId);
  if (delErr) throw new Error(`limpar stages seed: ${delErr.message}`);

  const rows = STAGES.map(([name, slug, position, color, isWon, isLost]) => ({
    organization_id: orgId,
    pipeline_id: pipelineId,
    name,
    slug,
    position,
    color,
    is_won: isWon,
    is_lost: isLost,
  }));
  const { error: insErr } = await admin.from("crm_stages").insert(rows as never);
  if (insErr) throw new Error(`inserir stages: ${insErr.message}`);
  console.log(`[pipeline] 5 stages recriadas (1 won: concluido, 1 lost: cancelado)`);

  return pipelineId;
}

async function main(): Promise<void> {
  const darlei = await ensureAuthUser(DARLEI_EMAIL, env.DARLEI_PASSWORD, "Darlei Cabral");
  const samilis = await ensureAuthUser(SAMILIS_EMAIL, env.SAMILIS_PASSWORD, "Samilis Neves");

  const { id: orgId } = await ensureOrg(darlei.id);

  await ensureMembership(darlei.id, orgId, "admin");
  await ensureMembership(samilis.id, orgId, "agent");

  const pipelineId = await remodelPipeline(orgId);

  console.log("\n✅ Tenant Itaville pronto.");
  console.log("──────────────────────────────────────────────");
  console.log(`  org:        ${orgId} (slug=${ORG_SLUG})`);
  console.log(`  pipeline:   ${pipelineId} (Chamados Pós-venda)`);
  console.log(`  admin:      ${DARLEI_EMAIL}  → ${darlei.id}`);
  console.log(
    `              senha: ${darlei.password ?? "(inalterada — usuário já existia; use 'esqueci a senha')"}`,
  );
  console.log(`  agent:      ${SAMILIS_EMAIL}  → ${samilis.id}`);
  console.log(
    `              senha: ${samilis.password ?? "(inalterada — usuário já existia; defina SAMILIS_PASSWORD p/ resetar)"}`,
  );
  console.log(`  CRM:        ${APP_URL}`);
  console.log("──────────────────────────────────────────────");
  console.log("  Faça login e troque para a organização Itaville.");
}

main().catch((err) => {
  console.error("❌ seed-itaville falhou:", err);
  process.exit(1);
});
