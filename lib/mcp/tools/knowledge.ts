/**
 * MCP tool de busca semântica na base de conhecimento do tenant.
 *
 * Por que existe: o runtime vivo (ToolLoopAgent, lib/ai/runtime/agent.ts) NÃO
 * faz RAG vetorial — ele só chama tools MCP. Sem esta tool, um agente não tem
 * como consultar catálogo/base de conhecimento (imóveis, produtos, políticas)
 * e acabaria inventando dados. Esta tool expõe o mesmo índice `ai_chunks` +
 * `retrieve_top_k_chunks` que alimenta o ai-response-worker, mas sob demanda,
 * como ferramenta que o agente decide quando chamar.
 *
 * Escopo por tenant: resolve a versão de KB ativa do agente default+ativo da
 * org (ai_agents.active_kb_version_id) e filtra `organization_id` — RLS-safe.
 */
import { z } from "zod";

import { embedText } from "@/lib/ai/embed";
import { isEmbeddingProviderConfigured } from "@/lib/ai/gateway";
import type { McpToolDefinition } from "../types";

const searchInputShape = {
  query: z
    .string()
    .trim()
    .min(2)
    .max(500)
    .describe("O que buscar na base de conhecimento (ex.: 'apartamento 2 quartos Floramar até 500 mil')."),
  limit: z.number().int().min(1).max(10).default(5),
};

export const crmSearchKnowledge: McpToolDefinition<typeof searchInputShape> = {
  name: "crm_search_knowledge",
  description:
    "Busca na base de conhecimento do negócio (catálogo, imóveis/produtos, políticas, FAQs) por similaridade semântica. Use SEMPRE antes de responder qualquer pergunta factual sobre itens do catálogo, preços, disponibilidade ou regras — nunca invente esses dados. Retorna os trechos mais relevantes com pontuação de similaridade.",
  inputSchema: searchInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    if (!isEmbeddingProviderConfigured()) {
      return { results: [], note: "Busca de conhecimento indisponível (provedor de embeddings não configurado)." };
    }

    // Resolve a versão de KB ativa do agente default+ativo desta org.
    const { data: agent } = await ctx.supabase
      .from("ai_agents")
      .select("id, active_kb_version_id, is_default, is_active, created_at")
      .eq("organization_id", ctx.organizationId)
      .eq("is_active", true)
      .order("is_default", { ascending: false })
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    const kbVersionId = (agent as { active_kb_version_id: string | null } | null)?.active_kb_version_id ?? null;
    if (!kbVersionId) {
      return { results: [], note: "Nenhuma base de conhecimento ativa para este tenant." };
    }

    let embedding: number[];
    try {
      const res = await embedText(input.query, { organizationId: ctx.organizationId });
      embedding = res.embedding;
    } catch {
      return { results: [], note: "Falha ao gerar embedding da busca." };
    }

    const { data, error } = await ctx.supabase.rpc("retrieve_top_k_chunks" as never, {
      p_organization_id: ctx.organizationId,
      p_kb_version_id: kbVersionId,
      p_embedding: `[${embedding.join(",")}]`,
      // Threshold um pouco mais baixo que o do worker: aqui o próprio agente
      // julga a relevância do que voltar, então priorizamos recall.
      p_threshold: 0.35,
      p_k: input.limit,
    } as never);

    if (error) {
      return { results: [], note: `Erro na busca: ${error.message}` };
    }

    type RpcRow = { content: string; similarity: number; metadata: Record<string, unknown> | null };
    const results = ((data ?? []) as RpcRow[]).map((r) => ({
      content: r.content,
      similarity: Number(r.similarity.toFixed(3)),
      source: (r.metadata?.["source_name"] as string | undefined) ?? null,
    }));

    return {
      results,
      count: results.length,
      note: results.length === 0 ? "Nenhum trecho relevante encontrado para essa busca." : undefined,
    };
  },
};
