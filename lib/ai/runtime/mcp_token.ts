/**
 * Ephemeral api_token mint for the agent runtime (S-13.08).
 *
 * Each run mints a short-lived (TTL 300s) `api_tokens` row scoped to MCP
 * read+write+ai_agent + a `agent_run:<runId>` marker. The runtime calls MCP
 * tools in-process (no HTTP loopback) but keeps the token row to satisfy
 * audit FK (`api_audit_log.actor_api_token_id`) and provide a real handle for
 * downstream tracing.
 *
 * `created_by` is required by the schema. Resolution order:
 *   1. version.created_by (passed by the caller)
 *   2. agent.created_by (passed by the caller)
 *   3. first admin in user_organizations for the org
 * If none, throws — runtime aborts with `error_code='no_actor_user'`.
 */
import { createHash, randomBytes } from "node:crypto";

import { createAdminClient } from "@/lib/supabase/admin";

export const EPHEMERAL_TOKEN_TTL_SEC = 300;

export interface MintEphemeralTokenInput {
  organizationId: string;
  runId: string;
  versionCreatedBy?: string | null;
  agentCreatedBy?: string | null;
  ttlSec?: number;
}

export interface EphemeralToken {
  id: string;
  plaintext: string;
  expiresAt: string;
}

async function resolveCreatedBy(
  organizationId: string,
  ...candidates: Array<string | null | undefined>
): Promise<string | null> {
  for (const c of candidates) {
    if (c) return c;
  }
  const admin = createAdminClient();
  const { data } = await admin
    .from("user_organizations")
    .select("user_id, role")
    .eq("organization_id", organizationId)
    .order("role", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.user_id as string | undefined) ?? null;
}

export async function mintEphemeralToken(
  input: MintEphemeralTokenInput,
): Promise<EphemeralToken> {
  const ttl = input.ttlSec ?? EPHEMERAL_TOKEN_TTL_SEC;
  const createdBy = await resolveCreatedBy(
    input.organizationId,
    input.versionCreatedBy,
    input.agentCreatedBy,
  );
  if (!createdBy) {
    throw new Error("no_actor_user_for_ephemeral_token");
  }

  const prefix = `dsk_run_${input.runId.slice(0, 8)}`;
  const secret = randomBytes(32).toString("base64url");
  const plaintext = `${prefix}_${secret}`;
  const tokenHash = createHash("sha256").update(plaintext).digest();
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("api_tokens")
    .insert({
      organization_id: input.organizationId,
      created_by: createdBy,
      name: `agent-run:${input.runId}`,
      prefix,
      token_hash: `\\x${tokenHash.toString("hex")}`,
      scopes: [
        "mcp:read",
        "mcp:write",
        "actor:ai_agent",
        `agent_run:${input.runId}`,
        "role:agent",
      ],
      expires_at: expiresAt,
    })
    .select("id, expires_at")
    .single();

  if (error || !data) {
    throw new Error(`ephemeral_token_insert_failed: ${error?.message ?? "unknown"}`);
  }

  return { id: data.id as string, plaintext, expiresAt: data.expires_at as string };
}

export async function revokeEphemeralToken(tokenId: string): Promise<void> {
  const admin = createAdminClient();
  await admin
    .from("api_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", tokenId);
}
