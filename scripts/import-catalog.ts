/**
 * scripts/import-catalog.ts — importa/atualiza o catálogo estruturado
 * (`crm_products`, C3) de uma org a partir de um manifesto JSON.
 *
 * Genérico por design (nada chumbado pra Avant): o manifesto aponta pra um
 * arquivo de itens já no formato das colunas de crm_products; a conversão
 * fonte→itens é responsabilidade de um script por tenant (ex.:
 * avant-imoveis/gerar-catalogo-crm.py gera catalogo-crm.json a partir da
 * MESMA fonte do RAG, mantendo refs/preços/links consistentes com o bot).
 *
 * Idempotente: upsert por (organization_id, external_ref). Itens da org que
 * NÃO estão mais no arquivo viram status='inactive' (vendido/retirado some
 * do crm_search_catalog sem perder o vínculo histórico com leads). Desligue
 * com "deactivate_missing": false.
 *
 * Uso:
 *   CATALOG_MANIFEST="D:/HD downloads/CLAUDE/avant-imoveis/catalog-manifest.json" \
 *   npx --yes tsx scripts/import-catalog.ts
 *
 * Manifest (JSON):
 *   {
 *     "org_slug": "avant",            // ou "org_id": "<uuid>"
 *     "items_file": "catalogo-crm.json",  // relativo à pasta do manifesto
 *     "deactivate_missing": true          // default true
 *   }
 */

import { createClient } from "@supabase/supabase-js";
import * as fs from "node:fs";
import * as path from "node:path";

// --- env (mesmo padrão de ingest-knowledge.ts) --------------------------------
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
const MANIFEST_PATH = env.CATALOG_MANIFEST || process.argv[2];

if (!SUPABASE_URL || !SERVICE_ROLE) throw new Error("Faltam NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.");
if (!MANIFEST_PATH) throw new Error("Passe o manifesto via CATALOG_MANIFEST=... ou primeiro argumento.");

interface Manifest {
  org_slug?: string;
  org_id?: string;
  items_file: string;
  deactivate_missing?: boolean;
}

interface CatalogItem {
  external_ref: string;
  kind?: string;
  status?: string;
  title: string;
  description?: string | null;
  price_cents?: number | null;
  currency?: string;
  location?: string | null;
  url?: string | null;
  image_url?: string | null;
  attributes?: Record<string, unknown>;
}

async function main() {
  const manifestDir = path.dirname(path.resolve(MANIFEST_PATH));
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
  const itemsPath = path.resolve(manifestDir, manifest.items_file);
  const items = JSON.parse(fs.readFileSync(itemsPath, "utf8")) as CatalogItem[];
  if (!Array.isArray(items) || items.length === 0) throw new Error(`Nenhum item em ${itemsPath}.`);

  const bad = items.filter((i) => !i.external_ref || !i.title);
  if (bad.length > 0) throw new Error(`${bad.length} itens sem external_ref/title — aborto.`);

  const supabase = createClient(SUPABASE_URL!, SERVICE_ROLE!, {
    auth: { persistSession: false },
  });

  // resolve org
  let orgId = manifest.org_id ?? null;
  if (!orgId) {
    if (!manifest.org_slug) throw new Error("Manifesto precisa de org_slug ou org_id.");
    const { data, error } = await supabase
      .from("organizations")
      .select("id, display_name")
      .eq("slug", manifest.org_slug)
      .single();
    if (error || !data) throw new Error(`Org slug '${manifest.org_slug}' não encontrada: ${error?.message}`);
    orgId = data.id as string;
    console.log(`Org: ${data.display_name} (${orgId})`);
  }

  const rows = items.map((i) => ({
    organization_id: orgId,
    external_ref: String(i.external_ref),
    kind: i.kind ?? "imovel",
    status: i.status ?? "active",
    title: i.title,
    description: i.description ?? null,
    price_cents: i.price_cents ?? null,
    currency: i.currency ?? "BRL",
    location: i.location ?? null,
    url: i.url ?? null,
    image_url: i.image_url ?? null,
    attributes: i.attributes ?? {},
  }));

  // upsert em lotes (evita payloads gigantes)
  const BATCH = 100;
  let upserted = 0;
  for (let off = 0; off < rows.length; off += BATCH) {
    const batch = rows.slice(off, off + BATCH);
    const { error } = await supabase
      .from("crm_products")
      .upsert(batch, { onConflict: "organization_id,external_ref" });
    if (error) throw new Error(`Upsert falhou (offset ${off}): ${error.message}`);
    upserted += batch.length;
  }
  console.log(`Upsert: ${upserted} itens.`);

  if (manifest.deactivate_missing !== false) {
    const keepRefs = rows.map((r) => r.external_ref);
    const { data: gone, error } = await supabase
      .from("crm_products")
      .update({ status: "inactive" })
      .eq("organization_id", orgId)
      .eq("status", "active")
      .not("external_ref", "is", null)
      .not("external_ref", "in", `(${keepRefs.map((r) => `"${r}"`).join(",")})`)
      .select("external_ref");
    if (error) throw new Error(`Desativação dos ausentes falhou: ${error.message}`);
    console.log(`Desativados (fora do arquivo): ${gone?.length ?? 0}.`);
  }

  const { count } = await supabase
    .from("crm_products")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .eq("status", "active");
  console.log(`Ativos na org após import: ${count}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
