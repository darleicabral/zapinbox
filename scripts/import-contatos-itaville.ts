/**
 * scripts/import-contatos-itaville.ts — cria os contatos da Itaville a partir do
 * JSON gerado por `D:\HD downloads\CLAUDE\CRM\gerar-compradores-itaville.py`.
 *
 * Por que um script e não o importador da tela: a tela importa nome/telefone/
 * e-mail/empreendimento, e esta planilha traz ainda as **tags** (PRIORIDADE,
 * INADIMPLENTE, TROCA DE TIT, NÃO CONTATAR) e a marca de exterior. "NÃO
 * CONTATAR" precisa virar contato **bloqueado**, senão alguém liga pra quem a
 * construtora não pode contatar.
 *
 * O arquivo de dados fica FORA do repo (tem PII: telefone/e-mail).
 *
 *   CONTATOS_JSON="D:\HD downloads\CLAUDE\CRM\itaville-contatos.json" \
 *   APPLY=1 npx tsx scripts/import-contatos-itaville.ts
 *
 * Sem APPLY=1 faz ensaio: valida tudo e mostra o resumo sem gravar.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

function env(key: string, required = true): string {
  if (process.env[key]) return process.env[key]!;
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const [k, ...rest] = line.split("=");
    if (k?.trim() === key) return rest.join("=").trim().replace(/^"|"$/g, "");
  }
  if (required) throw new Error(`${key} ausente (env ou .env.local)`);
  return "";
}

const ORG = "bd014ed4-f62f-42f3-b092-3182cef3ef0b";
const APPLY = process.env.APPLY === "1";
const LOTE = 100;

/** Mesmas regras dos CHECKs do banco — barrar aqui dá erro legível. */
const E164 = /^\+\d{8,15}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

interface Entrada {
  name: string;
  phone_number: string | null;
  email: string | null;
  tags: string[];
  empreendimento: string | null;
  blocked: boolean;
  unidades: string[];
}

async function main(): Promise<void> {
  const arquivo = env("CONTATOS_JSON");
  const entradas = JSON.parse(readFileSync(arquivo, "utf8")) as Entrada[];
  const agora = new Date().toISOString();

  const linhas: Record<string, unknown>[] = [];
  const recusados: string[] = [];
  const vistosFone = new Set<string>();
  const vistosEmail = new Set<string>();

  for (const e of entradas) {
    const nome = (e.name ?? "").trim();
    if (!nome) {
      recusados.push("(sem nome)");
      continue;
    }
    let fone = e.phone_number?.trim() || null;
    if (fone && !E164.test(fone)) {
      recusados.push(`${nome}: telefone fora do E.164 (${fone})`);
      fone = null;
    }
    let email = e.email?.trim() || null;
    if (email && !EMAIL.test(email)) {
      recusados.push(`${nome}: e-mail inválido (${email})`);
      email = null;
    }
    // Índices únicos do banco: (org, phone_number) e (org, email_normalized).
    // Duplicata aqui derrubaria o lote inteiro com 23505.
    if (fone && vistosFone.has(fone)) {
      recusados.push(`${nome}: telefone repetido no arquivo (${fone})`);
      continue;
    }
    if (email && vistosEmail.has(email.toLowerCase())) {
      recusados.push(`${nome}: e-mail repetido no arquivo (${email})`);
      email = null;
    }
    if (fone) vistosFone.add(fone);
    if (email) vistosEmail.add(email.toLowerCase());

    linhas.push({
      organization_id: ORG,
      name: nome,
      phone_number: fone,
      email,
      tags: e.tags ?? [],
      source: "planilha",
      source_metadata: {
        planilha: "Compradores 25-26",
        importado_em: agora,
        unidades: e.unidades ?? [],
      },
      custom_fields: e.empreendimento ? { empreendimento: e.empreendimento } : {},
      // ⚠️ TODAS as linhas precisam das MESMAS chaves. O PostgREST monta um único
      // INSERT com a união das colunas do lote, e a linha que não trouxe a chave
      // recebe NULL em vez do DEFAULT — `is_blocked` é NOT NULL e o lote inteiro
      // morria com 23502.
      is_blocked: e.blocked,
      blocked_reason: e.blocked ? "planilha: NÃO CONTATAR" : null,
      blocked_at: e.blocked ? agora : null,
    });
  }

  console.log(APPLY ? "*** MODO EXECUÇÃO ***" : "--- ensaio ---");
  console.log(`arquivo: ${arquivo}`);
  console.log(`prontos: ${linhas.length}   recusados: ${recusados.length}`);
  console.log(`  com telefone: ${linhas.filter((l) => l.phone_number).length}`);
  console.log(`  bloqueados:   ${linhas.filter((l) => l.is_blocked).length}`);
  for (const r of recusados.slice(0, 10)) console.log(`  ! ${r}`);
  if (recusados.length > 10) console.log(`  … e mais ${recusados.length - 10}`);

  if (!APPLY) {
    console.log("\nRode com APPLY=1 para gravar.");
    return;
  }

  const db = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false },
  });

  let criados = 0;
  for (let i = 0; i < linhas.length; i += LOTE) {
    const parte = linhas.slice(i, i + LOTE);
    const { data, error } = await db.from("contacts").insert(parte).select("id");
    if (error) throw new Error(`lote ${i / LOTE + 1}: ${error.code} ${error.message}`);
    criados += data?.length ?? 0;
    console.log(`  lote ${i / LOTE + 1}: ${data?.length ?? 0} criados`);
  }

  const { count } = await db
    .from("contacts")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", ORG);
  console.log(`\ncriados: ${criados}   total na org agora: ${count}`);
}

void main();
