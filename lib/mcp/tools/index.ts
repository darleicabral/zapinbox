/**
 * Catalogo agregado de tools MCP.
 *
 *  Wave 3 (S-13.03): 5 read tools (contacts, conversations, messages history).
 *  Wave 4 (S-13.04): +3 read (leads list/get, pipelines list)
 *                    +4 write (create_lead, update_lead, move_lead_stage, send_whatsapp)
 *                    +1 handoff (request_human_handoff). Total 13 tools.
 */
import type { McpToolDefinition } from "../types";
import { TOOL_CATALOG, VALID_TOOL_IDS } from "./catalog";
import { crmSearchContacts, crmGetContact } from "./contacts";
import {
  crmListConversations,
  crmGetConversation,
  crmGetConversationHistory,
} from "./conversations";
import {
  crmListLeads,
  crmGetLead,
  crmCreateLead,
  crmUpdateLead,
  crmMoveLeadStage,
} from "./leads";
import { crmListPipelines } from "./pipelines";
import { crmSendWhatsappMessage } from "./messages";
import { crmRequestHumanHandoff } from "./handoff";

// Cast via `unknown` porque McpToolDefinition<TInput> nao e covariante
// em TInput (handler usa TInput em posicao contravariante). Coletar
// definicoes heterogeneas em array unico exige apagar o input shape no
// nivel do array — o server core ja recebe args como `Record<string,
// unknown>` e cada handler valida no Zod do registerTool.
export const allTools: ReadonlyArray<McpToolDefinition> = [
  // read
  crmSearchContacts,
  crmGetContact,
  crmListConversations,
  crmGetConversation,
  crmGetConversationHistory,
  crmListLeads,
  crmGetLead,
  crmListPipelines,
  // write
  crmCreateLead,
  crmUpdateLead,
  crmMoveLeadStage,
  crmSendWhatsappMessage,
  // handoff (special)
  crmRequestHumanHandoff,
] as unknown as ReadonlyArray<McpToolDefinition>;

// Sanity: catalogo estatico (importavel por client) deve cobrir 1:1 os handlers.
// Erro em dev se alguem adicionar handler sem atualizar catalog.ts.
if (process.env.NODE_ENV !== "production") {
  const handlerNames = new Set(allTools.map((t) => t.name));
  const catalogNames = new Set(TOOL_CATALOG.map((t) => t.name));
  for (const n of handlerNames) {
    if (!catalogNames.has(n)) {
      throw new Error(`mcp/tools: handler "${n}" ausente em lib/mcp/tools/catalog.ts`);
    }
  }
  for (const n of catalogNames) {
    if (!handlerNames.has(n)) {
      throw new Error(`mcp/tools: catalog "${n}" sem handler correspondente`);
    }
  }
}

export { VALID_TOOL_IDS };

export function getToolByName(name: string): McpToolDefinition | undefined {
  return allTools.find((t) => t.name === name);
}
