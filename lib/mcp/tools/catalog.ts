/**
 * Catalogo estatico de tools MCP — apenas metadados (id, label, categoria).
 *
 * Este modulo NAO importa handlers nem nada que dependa de `next/headers`,
 * `lib/supabase/server`, ou audit log. Pode ser importado com seguranca por
 * Client Components (ex: AgentForm via lib/ai/agents/validation.ts).
 *
 * Runtime de execucao (handlers reais) vive em `lib/mcp/tools/index.ts` e so
 * pode ser importado por Server Components / Route Handlers / server actions.
 */
import type { McpToolCategory } from "../types";

export interface McpToolCatalogEntry {
  name: string;
  category: McpToolCategory;
  description: string;
}

export const TOOL_CATALOG: ReadonlyArray<McpToolCatalogEntry> = [
  // read
  { name: "crm_search_contacts", category: "read", description: "Busca contatos por nome/telefone/email" },
  { name: "crm_get_contact", category: "read", description: "Detalhe de um contato" },
  { name: "crm_list_conversations", category: "read", description: "Lista conversas" },
  { name: "crm_get_conversation", category: "read", description: "Detalhe de conversa" },
  { name: "crm_get_conversation_history", category: "read", description: "Historico de mensagens de uma conversa" },
  { name: "crm_list_leads", category: "read", description: "Lista leads de um pipeline" },
  { name: "crm_get_lead", category: "read", description: "Detalhe de lead" },
  { name: "crm_list_pipelines", category: "read", description: "Lista pipelines da org" },
  // write
  { name: "crm_create_lead", category: "write", description: "Cria um lead" },
  { name: "crm_update_lead", category: "write", description: "Atualiza campos de um lead" },
  { name: "crm_move_lead_stage", category: "write", description: "Move lead para outro stage" },
  { name: "crm_send_whatsapp_message", category: "write", description: "Envia mensagem WhatsApp" },
  // handoff
  { name: "crm_request_human_handoff", category: "handoff", description: "Solicita handoff para atendente humano" },
] as const;

export const VALID_TOOL_IDS: ReadonlyArray<string> = TOOL_CATALOG.map((t) => t.name);
