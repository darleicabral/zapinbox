/**
 * MCP tool — crm_flag_conversation_topic (triagem silenciosa da Itaville).
 *
 * Decisão Darlei (22/07): a IA NÃO cria mais um atendimento por conversa e NÃO
 * responde ao cliente. Ela apenas SINALIZA na conversa o assunto provável (ex.:
 * "parece distrato / jurídico") pra ajudar a atendente a priorizar a fila. Quem
 * decide abrir o atendimento é a atendente (botão "Abrir atendimento" no Inbox).
 *
 * Efeito: faz merge de `metadata.triagem` na `conversations` (não sobrescreve o
 * resto do metadata). Não cria lead, não envia mensagem. Genérico: as chaves são
 * sugestões (assunto/categoria/nível/resumo) exibidas como dica, não aplicadas.
 */
import { z } from "zod";

import type { McpToolDefinition } from "../types";

const inputShape = {
  conversation_id: z.string().uuid(),
  assunto: z
    .string()
    .min(1)
    .max(120)
    .describe(
      "Assunto provável em 1 linha, pra atendente bater o olho (ex.: 'distrato / jurídico', 'nova previsão de entrega', '2ª via de boleto').",
    ),
  categoria_sugerida: z
    .string()
    .min(1)
    .max(60)
    .optional()
    .describe("Categoria sugerida do menu do atendimento, se der pra inferir (ex.: 'Distrato e rescisão')."),
  nivel_sugerido: z
    .enum(["Verde", "Amarelo", "Vermelho"])
    .optional()
    .describe("Urgência sugerida: Vermelho (jurídico/distrato/ameaça), Amarelo (multa/prazo), Verde (dúvida simples)."),
  resumo: z
    .string()
    .min(1)
    .max(280)
    .optional()
    .describe("Resumo curto do que o cliente disse (1-2 frases)."),
};

export const crmFlagConversationTopic: McpToolDefinition<typeof inputShape> = {
  name: "crm_flag_conversation_topic",
  description:
    "SINALIZA na conversa o assunto provável do contato (triagem), SEM criar atendimento e SEM responder ao cliente. Chame uma vez, assim que entender o assunto da mensagem. A atendente humana lê a sinalização e decide abrir (ou não) o atendimento.",
  inputSchema: inputShape,
  category: "write",
  requiresRole: "agent",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const { data: conv, error: convErr } = await ctx.supabase
      .from("conversations")
      .select("id, organization_id, metadata")
      .eq("id", input.conversation_id)
      .maybeSingle();
    if (convErr) throw new Error(convErr.message);
    if (!conv || conv.organization_id !== ctx.organizationId) throw new Error("conversation_not_found");

    const prevMeta = ((conv as { metadata: Record<string, unknown> | null }).metadata ?? {}) as Record<
      string,
      unknown
    >;
    const triagem = {
      assunto: input.assunto,
      ...(input.categoria_sugerida ? { categoria_sugerida: input.categoria_sugerida } : {}),
      ...(input.nivel_sugerido ? { nivel_sugerido: input.nivel_sugerido } : {}),
      ...(input.resumo ? { resumo: input.resumo } : {}),
      at: new Date().toISOString(),
      by: "ia_triagem",
    };

    const { error: updErr } = await ctx.supabase
      .from("conversations")
      .update({ metadata: { ...prevMeta, triagem } })
      .eq("id", input.conversation_id)
      .eq("organization_id", ctx.organizationId);
    if (updErr) throw new Error(updErr.message);

    await ctx.supabase.rpc("emit_event" as never, {
      p_event_type: "conversation.triaged",
      p_entity_kind: "conversation",
      p_entity_id: input.conversation_id,
      p_payload: { assunto: input.assunto, nivel_sugerido: input.nivel_sugerido ?? null },
      p_metadata: { source: "crm_flag_conversation_topic" },
      p_organization_id: ctx.organizationId,
    } as never);

    return {
      flagged: true,
      assunto: input.assunto,
      next_action:
        "Não crie atendimento nem responda ao cliente. A sinalização já está visível pra atendente.",
    };
  },
};
