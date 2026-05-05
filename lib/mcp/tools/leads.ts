/**
 * MCP tools sobre /api/v1/leads (Spec 11 §3.1, §3.2).
 *
 *  Read:
 *   - crm_list_leads
 *   - crm_get_lead
 *  Write:
 *   - crm_create_lead
 *   - crm_update_lead
 *   - crm_move_lead_stage  (sem mirror REST direto; reusa moveLeadHandler)
 *
 * Write tools exigem role>=manager + scope mcp:write (gate no server core).
 */
import { z } from "zod";

import {
  listLeadsHandler,
  getLeadHandler,
  createLeadHandler,
  updateLeadHandler,
  moveLeadHandler,
} from "@/app/api/v1/leads/_handler";
import { createLeadSchema, updateLeadSchema } from "@/lib/schemas/leads";
import type { McpToolDefinition } from "../types";

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

const listInputShape = {
  pipeline_id: z.string().uuid().optional(),
  stage_id: z.string().uuid().optional(),
  status: z.enum(["open", "won", "lost"]).optional(),
  owner_user_id: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
};

export const crmListLeads: McpToolDefinition<typeof listInputShape> = {
  name: "crm_list_leads",
  description:
    "Lista leads do CRM filtrando por pipeline, stage, status e owner. Cursor base64 para paginação.",
  inputSchema: listInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    const result = await listLeadsHandler(
      ctx.supabase,
      {
        organization_id: ctx.organizationId,
        actor: ctx.actor,
        requestId: ctx.requestId,
      },
      {
        pipeline_id: input.pipeline_id,
        stage_id: input.stage_id,
        status: input.status,
        owner_user_id: input.owner_user_id,
        limit: input.limit,
        cursor: input.cursor,
      },
    );
    return {
      leads: result.leads,
      cursor: result.cursor,
      has_more: result.has_more,
    };
  },
};

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

const getInputShape = {
  lead_id: z.string().uuid(),
};

export const crmGetLead: McpToolDefinition<typeof getInputShape> = {
  name: "crm_get_lead",
  description: "Retorna um lead pelo UUID. Inclui pipeline_id, stage_id, status, owner.",
  inputSchema: getInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    const lead = await getLeadHandler(
      ctx.supabase,
      {
        organization_id: ctx.organizationId,
        actor: ctx.actor,
        requestId: ctx.requestId,
      },
      input.lead_id,
    );
    if ((lead as { organization_id?: string }).organization_id !== ctx.organizationId) {
      // Defesa em profundidade — service-role bypassa RLS.
      throw new Error("not_found");
    }
    return { lead };
  },
};

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

const createInputShape = {
  pipeline_id: z.string().uuid(),
  stage_id: z.string().uuid(),
  title: z.string().min(2).max(200),
  description: z.string().max(2000).optional(),
  contact_id: z.string().uuid().optional(),
  value_cents: z.number().int().nonnegative().optional(),
  currency: z.string().length(3).optional(),
  owner_user_id: z.string().uuid().optional(),
  expected_close_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  tags: z.array(z.string()).optional(),
  source: z.string().optional(),
};

export const crmCreateLead: McpToolDefinition<typeof createInputShape> = {
  name: "crm_create_lead",
  description:
    "Cria um lead no pipeline informado. Use após qualificar um contato. Position é gerenciado pelo servidor.",
  inputSchema: createInputShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const parsed = createLeadSchema.parse({
      pipeline_id: input.pipeline_id,
      stage_id: input.stage_id,
      title: input.title,
      description: input.description ?? null,
      contact_id: input.contact_id ?? null,
      value_cents: input.value_cents ?? null,
      currency: input.currency ?? "BRL",
      owner_user_id: input.owner_user_id ?? null,
      expected_close_date: input.expected_close_date ?? null,
      tags: input.tags ?? [],
      source: input.source ?? "ai_agent",
    });
    const lead = await createLeadHandler(
      ctx.supabase,
      {
        organization_id: ctx.organizationId,
        actor: ctx.actor,
        requestId: ctx.requestId,
      },
      parsed,
    );
    return { lead };
  },
};

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

const updateInputShape = {
  lead_id: z.string().uuid(),
  title: z.string().min(2).max(200).optional(),
  description: z.string().max(2000).optional(),
  contact_id: z.string().uuid().optional(),
  value_cents: z.number().int().nonnegative().optional(),
  currency: z.string().length(3).optional(),
  owner_user_id: z.string().uuid().optional(),
  expected_close_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  tags: z.array(z.string()).optional(),
};

export const crmUpdateLead: McpToolDefinition<typeof updateInputShape> = {
  name: "crm_update_lead",
  description:
    "Atualiza campos editáveis de um lead. Stage transitions são via crm_move_lead_stage; status é gerenciado por triggers.",
  inputSchema: updateInputShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const { lead_id, ...rest } = input;
    const parsed = updateLeadSchema.parse(rest);
    const lead = await updateLeadHandler(
      ctx.supabase,
      {
        organization_id: ctx.organizationId,
        actor: ctx.actor,
        requestId: ctx.requestId,
      },
      lead_id,
      parsed,
    );
    return { lead };
  },
};

// ---------------------------------------------------------------------------
// move stage
// ---------------------------------------------------------------------------

const moveInputShape = {
  lead_id: z.string().uuid(),
  to_stage_id: z.string().uuid(),
  position_in_stage: z.number().finite().optional(),
  reason: z.string().max(500).optional(),
};

export const crmMoveLeadStage: McpToolDefinition<typeof moveInputShape> = {
  name: "crm_move_lead_stage",
  description:
    "Move um lead para outro stage dentro do MESMO pipeline. Cross-pipeline é proibido (use clone). Audit registra from/to stage e reason.",
  inputSchema: moveInputShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const lead = await moveLeadHandler(
      ctx.supabase,
      {
        organization_id: ctx.organizationId,
        actor: ctx.actor,
        requestId: ctx.requestId,
      },
      input.lead_id,
      {
        to_stage_id: input.to_stage_id,
        position_in_stage: input.position_in_stage,
        reason: input.reason,
      },
    );
    return { lead };
  },
};
