"use server";

/**
 * Server Action: create the tenant's first ai_agent (default) and stamp the
 * onboarding state. Uses canonical Spec 05 defaults baked into ai_agents.
 */
import { redirect } from "next/navigation";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { aiAgentDefaultSchema, type PromptTemplate } from "@/lib/schemas/onboarding";
import { AGENT_CONFIG_DEFAULTS } from "@/lib/ai/guardrails-schema";
import { requireOnboardingCtx, patchOnboardingState, OnboardingError } from "./_shared";

const PROMPT_BODIES: Record<PromptTemplate, string> = {
  ecommerce_friendly: `Você é um(a) atendente virtual amigável de uma loja online. Cumprimente, entenda a dúvida do cliente, ofereça opções claras e use linguagem calorosa. Confirme detalhes do pedido antes de agir.`,
  ecommerce_professional: `Você é um(a) atendente virtual profissional de e-commerce. Comunicação objetiva, formal e empática. Sempre cite o número do pedido quando relevante e ofereça próximos passos práticos.`,
  support_minimal: `Você é um(a) agente de suporte minimalista. Responda em frases curtas, peça apenas o necessário e direcione para um humano quando a confiança for baixa.`,
};

export type CreateAgentResult =
  | { ok: true; agent_id: string }
  | { ok: false; error: "auth_required" | "no_active_org" | "invalid_input" | "db_error"; details?: unknown };

export async function createDefaultAgent(formData: FormData): Promise<CreateAgentResult> {
  let ctx;
  try {
    ctx = await requireOnboardingCtx();
  } catch (err) {
    if (err instanceof OnboardingError) return { ok: false, error: err.code as never };
    throw err;
  }

  const raw = {
    name: String(formData.get("name") ?? "Atendente IA").trim(),
    prompt_template: String(formData.get("prompt_template") ?? "ecommerce_friendly"),
  };

  let input;
  try {
    input = aiAgentDefaultSchema.parse(raw);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return { ok: false, error: "invalid_input", details: err.flatten() };
    }
    throw err;
  }

  const admin = createAdminClient();
  // Reset existing default to avoid trigger collisions if any.
  await admin
    .from("ai_agents")
    .update({ is_default: false })
    .eq("organization_id", ctx.orgId)
    .eq("is_default", true);

  const { data, error } = await admin
    .from("ai_agents")
    .insert({
      organization_id: ctx.orgId,
      name: input.name,
      system_prompt: PROMPT_BODIES[input.prompt_template],
      is_default: true,
      is_active: true,
      created_by: ctx.userId,
      // Explícito em vez de confiar no default da coluna: o default da
      // migration tem rag_similarity_threshold=0.72, irrealista pro
      // text-embedding-3-small (ver comentário em guardrails-schema.ts) —
      // sem isso o RAG do agente nunca retorna resultado nenhum.
      config: AGENT_CONFIG_DEFAULTS,
    })
    .select("id")
    .single();

  if (error || !data) {
    return { ok: false, error: "db_error", details: error?.message };
  }

  try {
    await patchOnboardingState(ctx.orgId, {
      ai: { agent_id: data.id as string, prompt_template: input.prompt_template },
    });
  } catch (err) {
    if (err instanceof OnboardingError) return { ok: false, error: "db_error", details: err.message };
    throw err;
  }

  await audit({
    action: "onboarding.ai_configured",
    actorUserId: ctx.userId,
    organizationId: ctx.orgId,
    resourceType: "ai_agent",
    resourceId: data.id as string,
    metadata: { prompt_template: input.prompt_template, name: input.name },
  });

  // Emit a domain event for downstream listeners (Spec 01 §7 event log).
  await admin.from("event_log").insert({
    organization_id: ctx.orgId,
    event_type: "ai_agent.created",
    payload: { agent_id: data.id, source: "onboarding" },
  });

  redirect("/onboarding/invite-team");
}

export async function skipAi(): Promise<void> {
  const ctx = await requireOnboardingCtx();
  await patchOnboardingState(ctx.orgId, {
    ai: { agent_id: "", prompt_template: "skipped", skipped: true },
  });
  redirect("/onboarding/invite-team");
}
