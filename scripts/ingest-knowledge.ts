/**
 * scripts/ingest-knowledge.ts — ingere documentos (.md/.txt) na base de
 * conhecimento (RAG) de um agente, gerando embeddings e ATIVANDO a versão.
 *
 * Por que existe: neste fork o pipeline de RAG para DOCUMENTOS não está
 * ligado — o upload salva o arquivo e conta chunks, mas o rag-indexer trata
 * `knowledge_source.updated` como stub (só produtos Nuvemshop embedam). Sem
 * uma versão de KB ativa o ai-response-worker faz `skip("kb_version_missing")`
 * e o bot nem responde. Este script fecha o buraco reaproveitando o MESMO
 * formato de dados que o retriever (`retrieve_top_k_chunks`) espera:
 *   ai_knowledge_versions (building→ready) + ai_knowledge_sources +
 *   ai_chunks (embedding vector(1536)) + activate_kb_version RPC.
 *
 * Idempotência: cada execução cria uma NOVA versão (immutável) e a ativa; o
 * retriever filtra por kb_version_id, então versões antigas ficam inertes.
 *
 * Uso:
 *   KB_MANIFEST="D:/HD downloads/CLAUDE/avant-imoveis/kb-manifest.json" \
 *   npx --yes tsx scripts/ingest-knowledge.ts
 *
 * Manifest (JSON):
 *   {
 *     "org_slug": "avant",              // ou "org_id": "<uuid>"
 *     "agent_id": "<uuid opcional>",    // default: agente default+ativo da org
 *     "sources": [
 *       { "file": "imoveis_base_conhecimento.txt", "type": "catalog", "name": "Catálogo de imóveis" },
 *       { "file": "sobre-avant.md", "type": "policy", "name": "Sobre a Avant" }
 *     ]
 *   }
 * Caminhos relativos em "file" resolvem a partir da pasta do manifesto.
 */

import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

// --- env (mesmo padrão de bootstrap-owner.ts) --------------------------------
function loadEnv(): Record<string, string> {
  const out: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const file of [".env", ".env.local"]) {
    const p = path.join(process.cwd(), file);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !out[m[1]!]) out[m[1]!] = m[2]!.replace(/\r$/, "").replace(/^"(.*)"$/, "$1");
    }
  }
  return out;
}

const env = loadEnv();
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE = env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_API_KEY = env.OPENAI_API_KEY;
const MANIFEST_PATH = env.KB_MANIFEST || process.argv[2];

if (!SUPABASE_URL || !SERVICE_ROLE) throw new Error("Faltam NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.");
if (!OPENAI_API_KEY) throw new Error("Falta OPENAI_API_KEY (embeddings text-embedding-3-small).");
if (!MANIFEST_PATH) throw new Error("Passe o manifesto via KB_MANIFEST=... ou primeiro argumento.");

const EMBED_MODEL = "text-embedding-3-small"; // 1536 dims == ai_chunks.embedding vector(1536)
const CATALOG_MAX_CHARS = 1600;
const CATALOG_OVERLAP_CHARS = 200;

type SourceType = "faq" | "policy" | "catalog";
interface ManifestSource {
  file: string;
  type: SourceType;
  name: string;
}
interface Manifest {
  org_slug?: string;
  org_id?: string;
  agent_id?: string;
  sources: ManifestSource[];
}

// --- chunking (porta fiel de lib/ai/rag/chunker.ts + ingest/policy.ts) -------
interface ChunkOptions {
  maxChars?: number;
  overlapChars?: number;
}

function chunkText(text: string, opts?: ChunkOptions): string[] {
  const maxChars = opts?.maxChars ?? 1500;
  const overlapChars = opts?.overlapChars ?? 200;

  const paragraphs = text
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const segments: string[] = [];
  for (const para of paragraphs) {
    if (para.length <= maxChars) {
      segments.push(para);
    } else {
      const sentences = para.split(/\.(?:\s|\n)/).filter((s) => s.trim().length > 0);
      let current = "";
      for (const sentence of sentences) {
        const candidate = current ? `${current}. ${sentence.trim()}` : sentence.trim();
        if (candidate.length > maxChars && current.length > 0) {
          segments.push(current.trim());
          current = sentence.trim();
        } else {
          current = candidate;
        }
      }
      if (current.trim().length > 0) segments.push(current.trim());
    }
  }

  if (segments.length === 0) return [];
  if (segments.length === 1) return segments[0] ? [segments[0]] : [];

  const chunks: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg) continue;
    if (i === 0) {
      chunks.push(seg);
      continue;
    }
    const prev = chunks[chunks.length - 1] ?? "";
    const tail = prev.length > overlapChars ? prev.slice(-overlapChars) : prev;
    chunks.push(`${tail}\n${seg}`.trim());
  }
  return chunks.filter((c) => c.length > 0);
}

const HEADING_RE = /^#{1,2}\s+.+$/m;

/** Split respeitando headings markdown antes do chunk padrão (ingest/policy.ts). */
function chunkDoc(text: string): string[] {
  if (!HEADING_RE.test(text)) {
    return chunkText(text, { maxChars: CATALOG_MAX_CHARS, overlapChars: CATALOG_OVERLAP_CHARS });
  }
  const lines = text.split("\n");
  const sections: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (/^#{1,2}\s+/.test(line) && current.length > 0) {
      const section = current.join("\n").trim();
      if (section.length > 0) sections.push(section);
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) {
    const section = current.join("\n").trim();
    if (section.length > 0) sections.push(section);
  }
  const chunks: string[] = [];
  for (const section of sections) {
    chunks.push(...chunkText(section, { maxChars: CATALOG_MAX_CHARS, overlapChars: CATALOG_OVERLAP_CHARS }));
  }
  return chunks.filter((c) => c.length > 0);
}

// Catálogos gerados como "registros" (ex.: `=== IMÓVEL #10 ===` ... próximo
// marcador) precisam de 1 registro = 1 chunk atômico. O chunker de prosa
// (chunkDoc) aplica overlap de 200 chars entre segmentos vizinhos — ótimo
// pra parágrafos de texto corrido, mas em catálogos isso cola o fim de um
// imóvel no começo do próximo, diluindo o embedding e derrubando a
// similaridade de busca. Detecta o padrão e, quando presente, ignora overlap
// entre registros (só sub-divide um registro individual se ele sozinho
// passar de CATALOG_MAX_CHARS).
const RECORD_MARKER_RE = /^={3,}\s*\S.*\S\s*={3,}$/m;

function chunkCatalogText(text: string): string[] {
  if (!RECORD_MARKER_RE.test(text)) {
    return chunkDoc(text);
  }
  const lines = text.split("\n");
  const records: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (RECORD_MARKER_RE.test(line.trim()) && current.length > 0) {
      const rec = current.join("\n").trim();
      if (rec.length > 0) records.push(rec);
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) {
    const rec = current.join("\n").trim();
    if (rec.length > 0) records.push(rec);
  }

  const chunks: string[] = [];
  for (const rec of records) {
    if (rec.length <= CATALOG_MAX_CHARS) {
      chunks.push(rec);
    } else {
      // Registro individual grande demais (descrição longa) — sub-divide SEM
      // vazar overlap pra outros registros (overlap fica só dentro dele mesmo).
      chunks.push(...chunkText(rec, { maxChars: CATALOG_MAX_CHARS, overlapChars: CATALOG_OVERLAP_CHARS }));
    }
  }
  return chunks.filter((c) => c.length > 0);
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

// --- OpenAI embeddings (REST, batch por source) ------------------------------
async function embedBatch(inputs: string[]): Promise<number[][]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: inputs }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI embeddings ${res.status}: ${body.slice(0, 400)}`);
  }
  const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
  // Garante ordem por index
  return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

/** pgvector aceita o literal textual '[a,b,c]' com cast text→vector via PostgREST. */
function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function resolveOrg(manifest: Manifest): Promise<string> {
  if (manifest.org_id) return manifest.org_id;
  if (!manifest.org_slug) throw new Error("Manifest precisa de org_slug ou org_id.");
  const { data, error } = await admin
    .from("organizations")
    .select("id")
    .eq("slug", manifest.org_slug)
    .maybeSingle();
  if (error || !data) throw new Error(`org slug=${manifest.org_slug} não encontrada: ${error?.message}`);
  return (data as { id: string }).id;
}

async function resolveAgent(orgId: string, manifest: Manifest): Promise<string> {
  if (manifest.agent_id) return manifest.agent_id;
  const { data, error } = await admin
    .from("ai_agents")
    .select("id, is_default, is_active, created_at")
    .eq("organization_id", orgId)
    .eq("is_active", true)
    .order("is_default", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error || !data) throw new Error(`nenhum agente ativo na org ${orgId}: ${error?.message}`);
  return (data as { id: string }).id;
}

async function nextVersionNumber(orgId: string, agentId: string): Promise<number> {
  const { data } = await admin
    .from("ai_knowledge_versions")
    .select("version_number")
    .eq("organization_id", orgId)
    .eq("agent_id", agentId)
    .order("version_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  return ((data?.version_number as number | null) ?? 0) + 1;
}

/**
 * Reset (default ligado; desligue com INGEST_RESET=false): apaga toda a KB
 * anterior do agente para reconstruir do zero a partir do manifesto.
 * Ordem respeita FKs: solta active_kb_version_id → deleta sources (CASCADE
 * apaga ai_chunks/ai_faq_items) → deleta versions.
 */
async function resetAgentKnowledge(orgId: string, agentId: string): Promise<void> {
  await admin.from("ai_agents").update({ active_kb_version_id: null } as never).eq("id", agentId);
  const { error: srcErr } = await admin
    .from("ai_knowledge_sources")
    .delete()
    .eq("organization_id", orgId)
    .eq("agent_id", agentId);
  if (srcErr) throw new Error(`reset sources: ${srcErr.message}`);
  const { error: verErr } = await admin
    .from("ai_knowledge_versions")
    .delete()
    .eq("organization_id", orgId)
    .eq("agent_id", agentId);
  if (verErr) throw new Error(`reset versions: ${verErr.message}`);
  console.log("[ingest] reset: KB anterior do agente removida");
}

/** Nome amigável da fonte consolidada por tipo (quando há mais de 1 doc do mesmo tipo). */
function sourceNameForType(type: SourceType, group: ManifestSource[]): string {
  if (group.length === 1) return group[0]!.name;
  const labels: Record<SourceType, string> = {
    catalog: "Catálogo de imóveis",
    policy: "Base de conhecimento (documentos)",
    faq: "Perguntas frequentes",
  };
  return labels[type];
}

async function main(): Promise<void> {
  const manifestAbs = path.resolve(MANIFEST_PATH);
  const manifest = JSON.parse(fs.readFileSync(manifestAbs, "utf8")) as Manifest;
  const baseDir = path.dirname(manifestAbs);

  const orgId = await resolveOrg(manifest);
  const agentId = await resolveAgent(orgId, manifest);
  console.log(`[ingest] org=${orgId} agent=${agentId} sources=${manifest.sources.length}`);

  if (env.INGEST_RESET !== "false") {
    await resetAgentKnowledge(orgId, agentId);
  }

  const versionNumber = await nextVersionNumber(orgId, agentId);
  const { data: ver, error: verErr } = await admin
    .from("ai_knowledge_versions")
    .insert({
      organization_id: orgId,
      agent_id: agentId,
      version_number: versionNumber,
      description: `Ingestão via scripts/ingest-knowledge.ts (${manifest.sources.length} fontes)`,
      status: "building",
      is_active: false,
    })
    .select("id")
    .single();
  if (verErr || !ver) throw new Error(`criar versão: ${verErr?.message}`);
  const versionId = (ver as { id: string }).id;
  console.log(`[ingest] versão ${versionNumber} criada (building): ${versionId}`);

  // ai_knowledge_sources tem índice único (agent_id, source_type) WHERE is_active
  // — agrupa os documentos do manifesto por tipo em UMA fonte cada.
  const groups = new Map<SourceType, ManifestSource[]>();
  for (const src of manifest.sources) {
    const arr = groups.get(src.type) ?? [];
    arr.push(src);
    groups.set(src.type, arr);
  }

  let totalChunks = 0;
  const snapshot: { source_id: string; name: string; type: string; chunks: number; files: string[] }[] = [];

  for (const [type, group] of groups) {
    const groupName = sourceNameForType(type, group);

    // Chunka cada arquivo do grupo separadamente (preserva metadata.file por chunk)
    // e concatena — mas cria a knowledge_source UMA vez por tipo.
    const perFileChunks: { file: string; chunks: string[] }[] = [];
    for (const src of group) {
      const filePath = path.isAbsolute(src.file) ? src.file : path.join(baseDir, src.file);
      if (!fs.existsSync(filePath)) throw new Error(`arquivo não existe: ${filePath}`);
      const text = fs.readFileSync(filePath, "utf8");
      const chunks = type === "catalog" ? chunkCatalogText(text) : chunkDoc(text);
      if (chunks.length === 0) {
        console.warn(`[ingest]  ⚠ ${src.name}: 0 chunks (pulado)`);
        continue;
      }
      perFileChunks.push({ file: path.basename(filePath), chunks });
    }
    if (perFileChunks.length === 0) continue;

    const totalGroupChunks = perFileChunks.reduce((n, f) => n + f.chunks.length, 0);

    const { data: ks, error: ksErr } = await admin
      .from("ai_knowledge_sources")
      .insert({
        organization_id: orgId,
        agent_id: agentId,
        source_type: type,
        name: groupName,
        status: "ready",
        ingested_at: new Date().toISOString(),
        chunks_count: totalGroupChunks,
        last_indexed_at: new Date().toISOString(),
        last_index_status: "success",
        source_metadata: {
          kb_version_id: versionId,
          files: perFileChunks.map((f) => f.file),
        },
      })
      .select("id")
      .single();
    if (ksErr || !ks) throw new Error(`criar knowledge_source ${groupName}: ${ksErr?.message}`);
    const ksId = (ks as { id: string }).id;

    let position = 0;
    for (const { file, chunks } of perFileChunks) {
      const embeddings = await embedBatch(chunks);
      if (embeddings.length !== chunks.length) {
        throw new Error(`embeddings (${embeddings.length}) != chunks (${chunks.length}) em ${file}`);
      }

      const rows = chunks.map((content, i) => ({
        organization_id: orgId,
        knowledge_source_id: ksId,
        kb_version_id: versionId,
        position: position + i,
        content,
        content_hash: sha256(content),
        token_count: Math.max(1, Math.ceil(content.length / 4)),
        embedding: toVectorLiteral(embeddings[i]!),
        metadata: { source_name: groupName, file },
      }));
      position += chunks.length;

      for (let i = 0; i < rows.length; i += 100) {
        const batch = rows.slice(i, i + 100);
        const { error: insErr } = await admin.from("ai_chunks").insert(batch as never);
        if (insErr) throw new Error(`inserir ai_chunks (${file}, lote ${i}): ${insErr.message}`);
      }
      console.log(`[ingest]    · ${file}: ${chunks.length} chunks`);
    }

    totalChunks += totalGroupChunks;
    snapshot.push({
      source_id: ksId,
      name: groupName,
      type,
      chunks: totalGroupChunks,
      files: perFileChunks.map((f) => f.file),
    });
    console.log(`[ingest]  ✓ ${groupName} (${type}): ${totalGroupChunks} chunks totais`);
  }

  // versão → ready + snapshot
  const { error: readyErr } = await admin
    .from("ai_knowledge_versions")
    .update({
      status: "ready",
      total_chunks: totalChunks,
      indexed_at: new Date().toISOString(),
      sources_snapshot: snapshot,
    })
    .eq("id", versionId)
    .eq("organization_id", orgId);
  if (readyErr) throw new Error(`marcar versão ready: ${readyErr.message}`);

  // ativa a versão no agente (RPC atômica, valida tenant)
  const { error: actErr } = await admin.rpc("activate_kb_version" as never, {
    p_agent_id: agentId,
    p_version_id: versionId,
  } as never);
  if (actErr) throw new Error(`activate_kb_version: ${actErr.message}`);

  // verifica
  const { data: agentRow } = await admin
    .from("ai_agents")
    .select("active_kb_version_id")
    .eq("id", agentId)
    .maybeSingle();

  console.log(
    `\n✅ Ingestão concluída.\n  versão ativa: ${versionId} (v${versionNumber})\n  chunks totais: ${totalChunks}\n  agent.active_kb_version_id: ${(agentRow as { active_kb_version_id: string | null } | null)?.active_kb_version_id}`,
  );
}

main().catch((err) => {
  console.error("❌ ingest-knowledge falhou:", err);
  process.exit(1);
});
