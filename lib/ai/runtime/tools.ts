/**
 * In-process MCP-tool bridge for the agent runtime (S-13.08).
 *
 * The agent runtime does NOT round-trip through `/api/mcp`; instead it pulls
 * tool definitions from the same catalog (`lib/mcp/tools/index.ts`) and wraps
 * each as an AI SDK `Tool`. Audit, role/scope checks, and PII redaction stay
 * identical because we reuse `auditMcpToolCall` and `ensureRole/ensureScope`.
 *
 * The handoff tool (`crm_request_human_handoff`) is special: when the agent
 * calls it, the runtime needs to know mid-flight so it can short-circuit the
 * loop. We wrap that tool's execute to publish a one-shot signal via
 * `runtimeHandoffSignal`, which `runAgent` checks after each step.
 */
import { tool, type Tool } from "ai";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

import { auditMcpToolCall } from "@/lib/mcp/audit";
import { ensureRole, ensureScope } from "@/lib/mcp/auth";
import type { McpAuthResult } from "@/lib/mcp/auth";
import { allTools, getToolByName } from "@/lib/mcp/tools";
import type { McpContext, McpToolDefinition } from "@/lib/mcp/types";

export interface RuntimeHandoffSignal {
  triggered: boolean;
  reason?: string;
  urgency?: string;
}

export interface PickToolsInput {
  supabase: SupabaseClient;
  ctx: McpContext;
  auth: McpAuthResult;
  toolIds: string[];
  handoffToolEnabled: boolean;
  /** Mutable signal — runtime checks after each step. */
  handoffSignal: RuntimeHandoffSignal;
}

const HANDOFF_TOOL_NAME = "crm_request_human_handoff";

function shapeToZodObject(shape: Record<string, z.ZodTypeAny>): z.ZodTypeAny {
  // The MCP tool inputSchema is a Zod *raw shape* (object of zod types).
  return z.object(shape);
}

function wrapMcpTool(
  def: McpToolDefinition,
  input: PickToolsInput,
): Tool {
  const inputSchema = shapeToZodObject(def.inputSchema as Record<string, z.ZodTypeAny>);

  return tool({
    description: def.description,
    inputSchema,
    execute: async (args: unknown) => {
      const startedAt = Date.now();
      const argsRecord = (args ?? {}) as Record<string, unknown>;
      try {
        ensureScope(input.auth.scopes, def.requiresScope);
        ensureRole(input.auth.role, def.requiresRole);

        const result = await def.handler(argsRecord as never, input.ctx);

        // Capture handoff signal so the runtime can short-circuit the loop.
        if (def.name === HANDOFF_TOOL_NAME) {
          input.handoffSignal.triggered = true;
          input.handoffSignal.reason = String(argsRecord.reason ?? "requested_human");
          input.handoffSignal.urgency = String(argsRecord.urgency ?? "normal");
        }

        void auditMcpToolCall({
          ctx: input.ctx,
          toolName: def.name,
          args: argsRecord,
          durationMs: Date.now() - startedAt,
          success: true,
        });
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : "unknown_error";
        void auditMcpToolCall({
          ctx: input.ctx,
          toolName: def.name,
          args: argsRecord,
          durationMs: Date.now() - startedAt,
          success: false,
          errorMessage: message,
        });
        // Return error to the model rather than throwing — keeps the loop alive.
        return { error: message };
      }
    },
  });
}

export function pickToolsFromMcp(input: PickToolsInput): Record<string, Tool> {
  const result: Record<string, Tool> = {};

  for (const id of input.toolIds) {
    const def = getToolByName(id);
    if (!def) continue;
    if (def.name === HANDOFF_TOOL_NAME && !input.handoffToolEnabled) continue;
    result[def.name] = wrapMcpTool(def, input);
  }

  // Auto-inject handoff tool when enabled even if not in tool_ids — Spec 10
  // §6 step 8 has it conditional on `handoff_tool_enabled` only.
  if (input.handoffToolEnabled && !result[HANDOFF_TOOL_NAME]) {
    const handoff = allTools.find((t) => t.name === HANDOFF_TOOL_NAME);
    if (handoff) {
      result[HANDOFF_TOOL_NAME] = wrapMcpTool(handoff, input);
    }
  }

  return result;
}
