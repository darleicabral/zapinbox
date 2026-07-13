/**
 * Schemas da tela de Configurações de Atendimento (/app/settings/attendance):
 * expediente (business_hours multi-janela), rodízio/SLA (attendance_settings)
 * e follow-up por inatividade (followup_settings).
 */
import { z } from "zod";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export const businessWindowSchema = z.object({
  days: z.array(z.number().int().min(0).max(6)).min(1, "Selecione ao menos um dia"),
  start: z.string().regex(HHMM, "Use HH:MM"),
  end: z.string().regex(HHMM, "Use HH:MM"),
});

export const businessHoursSchema = z.object({
  timezone: z.string().min(1),
  windows: z.array(businessWindowSchema).max(7),
});

export const followupStepSchema = z.object({
  after_minutes: z.number().int().min(1).max(43200), // até 30 dias
  message: z.string().min(1, "Mensagem obrigatória").max(1000),
  discard: z.boolean().optional(),
});

export const atendimentoSchema = z.object({
  // null = sem restrição de horário (24/7)
  business_hours: businessHoursSchema.nullable(),
  attendance: z.object({
    enabled: z.boolean(),
    claim_sla_minutes: z.number().int().min(1).max(1440),
    first_response_sla_minutes: z.number().int().min(1).max(1440),
    max_passes: z.number().int().min(1).max(10),
    notify_whatsapp: z.boolean(),
  }),
  followup: z.object({
    enabled: z.boolean(),
    throttle_seconds: z.number().int().min(0).max(60),
    steps: z.array(followupStepSchema).max(10),
  }),
});

export type BusinessWindowInput = z.infer<typeof businessWindowSchema>;
export type BusinessHoursInput = z.infer<typeof businessHoursSchema>;
export type FollowupStepInput = z.infer<typeof followupStepSchema>;
export type AtendimentoInput = z.infer<typeof atendimentoSchema>;
