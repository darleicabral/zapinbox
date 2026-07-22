/**
 * Zod schemas for /app/settings/* server actions and routes (EPIC-10).
 *
 * - profileSchema: persisted to auth.users.raw_user_meta_data
 * - tenantSchema: persisted to organizations row + organizations.settings jsonb
 * - notificationPrefsSchema: STUB (notification_prefs table not yet migrated)
 * - pipelineConfigPatchSchema: pipeline vocabulary + settings.fields + settings.lost_reasons
 */
import { z } from "zod";

const LOCALES = ["pt-BR", "en-US"] as const;
export type Locale = (typeof LOCALES)[number];

export const profileSchema = z.object({
  full_name: z.string().min(1).max(120).nullable().optional(),
  locale: z.enum(LOCALES),
  timezone: z.string().min(1).max(64),
  avatar_url: z
    .string()
    .url()
    .max(2048)
    .nullable()
    .optional()
    .or(z.literal("").transform(() => null)),
});
export type ProfileInput = z.infer<typeof profileSchema>;

export const tenantSchema = z.object({
  display_name: z.string().min(1).max(120),
  legal_name: z.string().min(1).max(200),
  cnpj: z
    .string()
    .max(20)
    .nullable()
    .optional()
    .or(z.literal("").transform(() => null)),
  timezone: z.string().min(1).max(64),
  locale: z.enum(LOCALES),
  media_retention_days: z.coerce.number().int().min(30).max(3650),
  dpo_email: z
    .string()
    .email()
    .max(200)
    .nullable()
    .optional()
    .or(z.literal("").transform(() => null)),
  privacy_policy_url: z
    .string()
    .url()
    .max(2048)
    .nullable()
    .optional()
    .or(z.literal("").transform(() => null)),
  lost_reasons_extra: z.array(z.string().min(1).max(80)).max(50).default([]),
});
export type TenantInput = z.infer<typeof tenantSchema>;

export const NOTIFICATION_CATEGORIES = [
  "lead_assigned",
  "lead_won",
  "lead_lost",
  "mention",
] as const;
export const NOTIFICATION_CHANNELS = ["email", "in_app", "push"] as const;

export const notificationPrefsSchema = z.object({
  prefs: z.array(
    z.object({
      category: z.enum(NOTIFICATION_CATEGORIES),
      channel: z.enum(NOTIFICATION_CHANNELS),
      enabled: z.boolean(),
    }),
  ),
});
export type NotificationPrefsInput = z.infer<typeof notificationPrefsSchema>;

const fieldOptionSchema = z.object({
  value: z.string().min(1).max(120),
  label: z.string().min(1).max(120),
});

const customFieldSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z][a-z0-9_]*$/i, "Use letras, números e underscore"),
  label: z.string().min(1).max(80),
  type: z.enum([
    "text",
    "textarea",
    "number",
    "date",
    "select",
    "multiselect",
    "boolean",
    "email",
    "phone",
    "url",
  ]),
  required: z.boolean().optional(),
  /** Campo de acompanhamento: some do diálogo de criação (só edição). */
  hideOnCreate: z.boolean().optional(),
  options: z.array(fieldOptionSchema).optional(),
  /**
   * Opções dependentes de outro campo (ex.: subcategoria depende de categoria).
   * PRECISA estar no schema: sem ela o Zod descartaria a chave ao salvar os
   * fields e quebraria a cascata (menus em cascata do CustomFieldsEditor).
   */
  optionsBy: z
    .object({
      field: z.string().min(1).max(40),
      map: z.record(z.string(), z.array(fieldOptionSchema)),
    })
    .optional(),
  /** Visibilidade condicional (ex.: bloco Van Gogh). Idem: preservar ao salvar. */
  showWhen: z
    .object({
      field: z.string().min(1).max(40),
      in: z.array(z.string().min(1).max(120)),
    })
    .optional(),
  /** Agrupa campos consecutivos num bloco realçado. Idem: preservar ao salvar. */
  section: z.string().min(1).max(80).optional(),
});

export const pipelineConfigPatchSchema = z.object({
  vocabulary: z
    .object({
      lead: z.string().min(1).max(40).optional(),
      deal: z.string().min(1).max(40).optional(),
      won: z.string().min(1).max(40).optional(),
      lost: z.string().min(1).max(40).optional(),
    })
    .optional(),
  fields: z.array(customFieldSchema).max(50).optional(),
  lost_reasons: z.array(z.string().min(1).max(80)).max(50).optional(),
});
export type PipelineConfigPatch = z.infer<typeof pipelineConfigPatchSchema>;
