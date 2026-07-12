/**
 * scripts/backfill-lid-phones.ts — preenche contacts.phone_number de contatos
 * @lid consultando o mapeamento lid→número do WAHA (engine NOWEB).
 *
 * Por que existe: chats @lid escondem o número no chatId; mensagens novas já
 * são resolvidas no ingest via _data.key.senderPn, mas contatos criados antes
 * desse fix ficaram sem telefone. O WAHA guarda o par lid↔pn da sessão:
 *   GET /api/{session}/lids/{lid}  ->  { lid, pn }
 *
 * Idempotente e conservador: só preenche phone_number quando está NULL.
 *
 * ⚠️ Requer NOWEB store na sessão WAHA (config.noweb.store.enabled=true +
 * full_sync=true ao criar/reiniciar a sessão) — sem isso a API /lids devolve
 * 400. As sessões criadas pelo CRM vêm com config:{} (sem store), então este
 * backfill só funciona após recriar a sessão com store. Alternativa que já
 * está no ar: o ingest preenche o telefone via _data.key.senderPn na próxima
 * mensagem que o contato mandar.
 *
 * Uso (na raiz do repo): npx --yes tsx scripts/backfill-lid-phones.ts
 */

import { createClient } from "@supabase/supabase-js";
import * as fs from "node:fs";
import * as path from "node:path";

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
const WAHA_URL = (env.WAHA_API_BASE_URL ?? "").replace(/\/$/, "");
const WAHA_KEY = env.WAHA_API_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE) throw new Error("Faltam NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.");
if (!WAHA_URL || !WAHA_KEY) throw new Error("Faltam WAHA_API_BASE_URL / WAHA_API_KEY.");

function pnToE164(pn: string | null | undefined): string | null {
  if (!pn) return null;
  const digits = pn.replace(/@.*$/, "").replace(/\D/g, "");
  return digits.length >= 8 ? `+${digits}` : null;
}

async function wahaLidToPn(session: string, lid: string): Promise<string | null> {
  const res = await fetch(`${WAHA_URL}/api/${encodeURIComponent(session)}/lids/${encodeURIComponent(lid)}`, {
    headers: { "X-Api-Key": WAHA_KEY! },
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { pn?: string | null };
  return pnToE164(body?.pn);
}

async function main() {
  const supabase = createClient(SUPABASE_URL!, SERVICE_ROLE!, { auth: { persistSession: false } });

  const { data: contacts, error } = await supabase
    .from("contacts")
    .select("id, organization_id, display_name, wa_identity")
    .like("wa_identity", "lid:%")
    .is("phone_number", null);
  if (error) throw new Error(error.message);
  if (!contacts?.length) {
    console.log("Nenhum contato @lid sem telefone — nada a fazer.");
    return;
  }
  console.log(`${contacts.length} contato(s) @lid sem telefone.`);

  // sessão WAHA de cada org
  const orgIds = Array.from(new Set(contacts.map((c) => c.organization_id as string)));
  const { data: sessions, error: sesErr } = await supabase
    .from("channel_sessions")
    .select("organization_id, waha_session_name, status")
    .in("organization_id", orgIds);
  if (sesErr) throw new Error(sesErr.message);
  const sessionByOrg = new Map<string, string>();
  for (const s of sessions ?? []) {
    // prioriza sessão WORKING; senão fica a última vista
    if (s.status === "WORKING" || !sessionByOrg.has(s.organization_id as string)) {
      sessionByOrg.set(s.organization_id as string, s.waha_session_name as string);
    }
  }

  let filled = 0;
  for (const c of contacts) {
    const lid = (c.wa_identity as string).replace(/^lid:/, "");
    const session = sessionByOrg.get(c.organization_id as string);
    if (!session) {
      console.log(`- ${c.display_name ?? c.id}: org sem sessão WAHA, pulando.`);
      continue;
    }
    const phone = await wahaLidToPn(session, lid);
    if (!phone) {
      console.log(`- ${c.display_name ?? c.id}: WAHA não conhece o lid ${lid}.`);
      continue;
    }
    const { error: upErr } = await supabase
      .from("contacts")
      .update({ phone_number: phone })
      .eq("id", c.id)
      .is("phone_number", null);
    if (upErr) {
      console.log(`- ${c.display_name ?? c.id}: update falhou: ${upErr.message}`);
      continue;
    }
    console.log(`✓ ${c.display_name ?? c.id}: ${phone}`);
    filled++;
  }
  console.log(`Preenchidos: ${filled}/${contacts.length}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
