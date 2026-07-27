"use server";
/**
 * Server Actions para a tela de lista de agents.
 *
 * Estas actions são wrappers thin sobre a mesma lógica das rotas REST em
 * `app/api/v1/ai/agents/[id]/...`. Usam `loadAuthUser` + `createAdminClient`
 * directamente para evitar fetch interno (e para reusar `audit()`).
 *
 * Mutations privilegiadas exigem role admin. Errors voltam em forma simples
 * `{ ok: false, error, message }` para a UI tratar com toast.
 */
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";

import { audit } from "@/lib/audit";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK, type Role } from "@/lib/auth/types";
import { createAdminClient } from "@/lib/supabase/admin";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ActionResult<T = void> =
  | { ok: true; data?: T }
  | { ok: false; error: string; message?: string };

type AdminGuard =
  | {
      kind: "ok";
      authUser: { id: string };
      activeOrg: { orgId: string; role: "viewer" | "agent" | "manager" | "admin" };
    }
  | { kind: "fail"; result: { ok: false; error: string } };

/**
 * `min` existe porque ligar/pausar o bot é operação (gerente faz), enquanto
 * criar, renomear, duplicar e arquivar agente segue sendo admin. Ver
 * lib/auth/permissions.ts.
 */
async function ensureRole(min: Role = "admin"): Promise<AdminGuard> {
  const authUser = await loadAuthUser();
  if (!authUser) return { kind: "fail", result: { ok: false, error: "unauthenticated" } };
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) return { kind: "fail", result: { ok: false, error: "forbidden_tenant" } };
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK[min]) {
    return { kind: "fail", result: { ok: false, error: "forbidden_role" } };
  }
  return { kind: "ok", authUser, activeOrg };
}

export async function pauseAgentAction(id: string): Promise<ActionResult> {
  if (!UUID_RX.test(id)) return { ok: false, error: "invalid_request" };
  const guard = await ensureRole("manager");
  if (guard.kind === "fail") return guard.result;
  const { authUser, activeOrg } = guard;

  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("ai_agents")
    .select("id, published_version_id, archived_at, is_active, kind")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();

  if (!existing) return { ok: false, error: "not_found" };
  if (existing.archived_at)
    return { ok: false, error: "state_conflict", message: "Agent arquivado." };

  const requestId = randomUUID();
  const previousVersionId = (existing as { published_version_id: string | null })
    .published_version_id;

  if (previousVersionId) {
    await admin
      .from("ai_agent_versions")
      .update({ status: "superseded", superseded_at: new Date().toISOString() })
      .eq("id", previousVersionId)
      .eq("organization_id", activeOrg.orgId)
      .eq("status", "published");
  }

  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    published_version_id: null,
  };
  // Legacy rag_bot: também flip is_active para refletir no badge.
  if (existing.kind !== "mcp_agent") updates.is_active = false;

  const { error } = await admin
    .from("ai_agents")
    .update(updates)
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId);
  if (error) return { ok: false, error: "internal_error", message: error.message };

  void audit({
    action: "ai_agent.paused",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "ai_agent",
    resourceId: id,
    requestId,
    metadata: { previous_version_id: previousVersionId },
  });

  revalidatePath("/app/ai/agents");
  return { ok: true };
}

export async function unpauseAgentAction(id: string): Promise<ActionResult> {
  if (!UUID_RX.test(id)) return { ok: false, error: "invalid_request" };
  const guard = await ensureRole("manager");
  if (guard.kind === "fail") return guard.result;
  const { authUser, activeOrg } = guard;

  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("ai_agents")
    .select("id, kind, archived_at, is_active")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();

  if (!existing) return { ok: false, error: "not_found" };
  if (existing.archived_at) return { ok: false, error: "state_conflict" };

  // mcp_agent não pode ser despausado por aqui — precisa ir em /publish escolhendo versão.
  if (existing.kind === "mcp_agent") {
    return { ok: false, error: "publish_required", message: "Publique uma versão para reativar." };
  }

  const { error } = await admin
    .from("ai_agents")
    .update({ is_active: true, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId);
  if (error) return { ok: false, error: "internal_error", message: error.message };

  void audit({
    action: "ai_agent.updated",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "ai_agent",
    resourceId: id,
    metadata: { unpaused: true },
  });

  revalidatePath("/app/ai/agents");
  return { ok: true };
}

export async function archiveAgentAction(id: string): Promise<ActionResult> {
  if (!UUID_RX.test(id)) return { ok: false, error: "invalid_request" };
  const guard = await ensureRole();
  if (guard.kind === "fail") return guard.result;
  const { authUser, activeOrg } = guard;

  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("ai_agents")
    .select("id, kind, is_default, archived_at")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (!existing) return { ok: false, error: "not_found" };
  if (existing.is_default) return { ok: false, error: "cannot_archive_default" };

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (existing.kind === "mcp_agent") {
    updates.archived_at = new Date().toISOString();
    updates.published_version_id = null;
  } else {
    updates.is_active = false;
  }

  const { error } = await admin
    .from("ai_agents")
    .update(updates)
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId);
  if (error) return { ok: false, error: "internal_error", message: error.message };

  void audit({
    action: "ai_agent.archived",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "ai_agent",
    resourceId: id,
    metadata: { kind: existing.kind },
  });

  revalidatePath("/app/ai/agents");
  return { ok: true };
}

export async function renameAgentAction(id: string, name: string): Promise<ActionResult> {
  if (!UUID_RX.test(id)) return { ok: false, error: "invalid_request" };
  const trimmed = (name ?? "").trim();
  if (trimmed.length < 1 || trimmed.length > 120) {
    return { ok: false, error: "validation_failed", message: "Nome entre 1 e 120 caracteres." };
  }
  const guard = await ensureRole();
  if (guard.kind === "fail") return guard.result;
  const { authUser, activeOrg } = guard;

  const admin = createAdminClient();
  const { error } = await admin
    .from("ai_agents")
    .update({ name: trimmed, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId);
  if (error) return { ok: false, error: "internal_error", message: error.message };

  void audit({
    action: "ai_agent.updated",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "ai_agent",
    resourceId: id,
    metadata: { renamed_to: trimmed },
  });

  revalidatePath("/app/ai/agents");
  return { ok: true };
}

export async function duplicateAgentAction(id: string): Promise<ActionResult<{ new_id: string }>> {
  if (!UUID_RX.test(id)) return { ok: false, error: "invalid_request" };
  const guard = await ensureRole();
  if (guard.kind === "fail") return guard.result;
  const { authUser, activeOrg } = guard;

  const admin = createAdminClient();

  const { data: source } = await admin
    .from("ai_agents")
    .select(
      "id, name, description, model, system_prompt, kind, priority, config, guardrails, active_kb_version_id",
    )
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (!source) return { ok: false, error: "not_found" };

  // Para mcp_agent, idealmente clona uma versão draft/published. Por simplicidade
  // de UX, fazemos cópia "shallow" — agent + duplicate row; a versão fica ausente
  // e o usuário re-publica. Conservador para a wave 10. (Spec 10 §4.3 detalha
  // clonagem completa via /api/v1/ai/agents/:id/duplicate, que continua disponível.)
  const { data: cloned, error } = await admin
    .from("ai_agents")
    .insert({
      organization_id: activeOrg.orgId,
      name: `${source.name} (cópia)`,
      description: source.description,
      model: source.model,
      system_prompt: source.system_prompt,
      kind: source.kind ?? "rag_bot",
      priority: source.priority ?? 100,
      is_active: false,
      is_default: false,
      config: source.config ?? {},
      guardrails: source.guardrails ?? null,
      active_kb_version_id: source.active_kb_version_id,
      created_by: authUser.id,
    })
    .select("id")
    .single();

  if (error || !cloned) {
    return { ok: false, error: "internal_error", message: error?.message };
  }

  void audit({
    action: "ai_agent.duplicated",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "ai_agent",
    resourceId: cloned.id,
    metadata: { source_agent_id: source.id },
  });

  revalidatePath("/app/ai/agents");
  return { ok: true, data: { new_id: cloned.id } };
}
