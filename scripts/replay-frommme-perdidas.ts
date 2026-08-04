/**
 * scripts/replay-frommme-perdidas.ts — recupera as mensagens enviadas PELO
 * CELULAR que o ingest descartou antes do conserto de 04/08/2026.
 *
 * Contexto: `handleOutboundFromUserPhone` lia o chat de `p.to`, que o NOWEB não
 * manda em evento fromMe (o chat vem em `p.from`). Resultado: toda resposta
 * dada no aparelho sumia, e a conversa no CRM ficava só com a fala do cliente.
 * Os eventos, porém, ficaram gravados em `webhook_events_log.payload_parsed` —
 * este script os passa de novo pelo roteador, agora corrigido.
 *
 * Só reprocessa **fromMe**. Reprocessar recebida seria perigoso: acionaria de
 * novo o agente de IA e os avisos de mensagem nova para conversas velhas.
 * Reexecução é idempotente: a unique (organization_id, external_id) barra o
 * que já entrou (23505 é tratado como sucesso no ingest).
 *
 *   ORG_ID=<uuid> npx tsx scripts/replay-frommme-perdidas.ts          → ensaio
 *   ORG_ID=<uuid> APPLY=1 npx tsx scripts/replay-frommme-perdidas.ts  → grava
 *
 * ⚠️ Exporte o `.env.local` ANTES de rodar. Este script importa o ingest, que
 * puxa `lib/env` — e `lib/env` valida no momento do import, antes de qualquer
 * linha daqui executar. Não dá para carregar o .env dentro do script.
 * PowerShell:
 *   Get-Content .env.local | % { if ($_ -match '^([A-Z0-9_]+)=(.*)$') {
 *     Set-Item "env:$($matches[1])" $matches[2] } }
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { dispatchWahaEvent, type WahaEnvelope } from "@/lib/waha/ingest";

const ORG = process.env.ORG_ID ?? "";
const APPLY = process.env.APPLY === "1";
/** Página do PostgREST. O log tem centenas de eventos: sem paginar, o `limit`
 *  pegava só os mais ANTIGOS e o replay perdia justamente os de hoje. */
const PAGINA = 1000;

interface LogRow {
  id: string;
  received_at: string;
  channel_session_id: string | null;
  payload_parsed: { event?: string; payload?: Record<string, unknown> } | null;
}

async function main(): Promise<void> {
  if (!ORG) throw new Error("Passe ORG_ID=<uuid>.");
  const admin = createAdminClient();

  const todos: LogRow[] = [];
  for (let pagina = 0; ; pagina++) {
    const de = pagina * PAGINA;
    const { data, error } = await admin
      .from("webhook_events_log")
      .select("id, received_at, channel_session_id, payload_parsed")
      .eq("organization_id", ORG)
      .in("event_type", ["message", "message.any"])
      .order("received_at", { ascending: true })
      .range(de, de + PAGINA - 1);
    if (error) throw new Error(error.message);
    const lote = (data ?? []) as LogRow[];
    todos.push(...lote);
    if (lote.length < PAGINA) break;
  }
  const data = todos;

  const fromMe = ((data ?? []) as LogRow[]).filter(
    (r) => r.payload_parsed?.payload?.fromMe === true && r.channel_session_id,
  );
  // O WAHA manda `message` E `message.any` para a mesma mensagem: deduplica pelo
  // id da mensagem, senão o replay processa cada uma duas vezes à toa.
  const porId = new Map<string, LogRow>();
  for (const r of fromMe) {
    const id = String(r.payload_parsed?.payload?.id ?? "");
    if (id && !porId.has(id)) porId.set(id, r);
  }
  const unicos = [...porId.values()];

  console.log(APPLY ? "*** MODO EXECUÇÃO ***" : "--- ensaio ---");
  console.log(`eventos de mensagem lidos: ${(data ?? []).length}`);
  console.log(`fromMe: ${fromMe.length}  (mensagens distintas: ${unicos.length})`);
  for (const r of unicos.slice(0, 8)) {
    const p = r.payload_parsed!.payload!;
    console.log(
      `  ${r.received_at.slice(0, 19)} ${String(p.from).slice(0, 24).padEnd(24)} ${String(p.body ?? "(mídia)").slice(0, 44)}`,
    );
  }
  if (unicos.length > 8) console.log(`  … e mais ${unicos.length - 8}`);

  if (!APPLY) {
    console.log("\nRode com APPLY=1 para reprocessar.");
    return;
  }

  // cache das sessões (todas as mensagens tendem a ser do mesmo número)
  const sessoes = new Map<string, Record<string, unknown>>();
  let ok = 0;
  let falhas = 0;
  for (const r of unicos) {
    const sid = r.channel_session_id!;
    if (!sessoes.has(sid)) {
      const { data: s } = await admin.from("channel_sessions").select("*").eq("id", sid).maybeSingle();
      if (!s) {
        falhas++;
        continue;
      }
      sessoes.set(sid, s as Record<string, unknown>);
    }
    const envelope: WahaEnvelope = {
      event: "message.any",
      payload: r.payload_parsed!.payload!,
    } as WahaEnvelope;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await dispatchWahaEvent(admin as any, sessoes.get(sid) as any, envelope, `replay-${r.id}`);
      ok++;
    } catch (e) {
      falhas++;
      console.log(`  ! ${r.id}: ${String(e).slice(0, 120)}`);
    }
  }
  console.log(`\nreprocessadas: ${ok}   falhas: ${falhas}`);

  const { count } = await admin
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", ORG)
    .eq("direction", "outbound")
    .eq("sent_via", "external_device");
  console.log(`mensagens do celular no banco agora: ${count ?? 0}`);
}

void main();
