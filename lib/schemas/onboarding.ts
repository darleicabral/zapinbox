/**
 * EPIC-02 Tenant Onboarding — Zod schemas for the wizard's Server Actions and
 * the persistent `organizations.onboarding_state jsonb` blob.
 */
import { z } from "zod";

export const welcomeSchema = z.object({
  display_name: z.string().min(2).max(120),
  timezone: z.string().min(1).default("America/Sao_Paulo"),
  accepted_terms_at: z.string().datetime().optional(),
});
export type WelcomeInput = z.infer<typeof welcomeSchema>;

export const PROMPT_TEMPLATES = [
  "ecommerce_friendly",
  "ecommerce_professional",
  "support_minimal",
] as const;
export type PromptTemplate = (typeof PROMPT_TEMPLATES)[number];

export const aiAgentDefaultSchema = z.object({
  name: z.string().min(2).max(80).default("Atendente IA"),
  prompt_template: z.enum(PROMPT_TEMPLATES).default("ecommerce_friendly"),
});
export type AiAgentDefaultInput = z.infer<typeof aiAgentDefaultSchema>;

export const onboardingStepSchema = z.enum([
  "welcome",
  "whatsapp",
  "nuvemshop",
  "ai",
  "team",
  "done",
]);
export type OnboardingStep = z.infer<typeof onboardingStepSchema>;

export const onboardingStateSchema = z.object({
  welcome: z
    .object({
      accepted_at: z.string(),
      timezone: z.string(),
      display_name: z.string(),
    })
    .optional(),
  whatsapp: z
    .object({
      session_id: z.string().optional(),
      session_name: z.string().optional(),
      status: z.string(),
      skipped: z.boolean().optional(),
    })
    .optional(),
  nuvemshop: z
    .object({
      connected_at: z.string().optional(),
      store_id: z.string().optional(),
      skipped: z.boolean().optional(),
    })
    .optional(),
  ai: z
    .object({
      agent_id: z.string(),
      prompt_template: z.string(),
      skipped: z.boolean().optional(),
    })
    .optional(),
  team: z
    .object({
      invites_sent: z.number(),
      skipped: z.boolean().optional(),
    })
    .optional(),
});
export type OnboardingState = z.infer<typeof onboardingStateSchema>;

export const inviteOnboardingSchema = z.object({
  invitations: z
    .array(
      z.object({
        email: z.string().email(),
        role: z.enum(["viewer", "agent", "manager", "admin"]),
      }),
    )
    .min(1)
    .max(20),
});
export type InviteOnboardingInput = z.infer<typeof inviteOnboardingSchema>;
