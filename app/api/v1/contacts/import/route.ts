/**
 * POST /api/v1/contacts/import — importação em lote de contatos (planilha).
 *
 * O parsing do arquivo é do CLIENTE (`lib/contacts/csv.ts`, puro e testado):
 * aqui chegam linhas já normalizadas. Isso mantém a rota simples, deixa o
 * usuário conferir o preview antes e evita upload de arquivo/multipart.
 *
 * Dedupe: o telefone é a identidade (`contacts.wa_identity` tem unique parcial
 * por org, migration 0027) — importar duas vezes ATUALIZA, não duplica. Nunca
 * sobrescreve dado preenchido: só completa o que está vazio.
 *
 * Client de SESSÃO (RLS). Requer agente ou acima — viewer não importa base.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { CONTACT_FIELD } from "@/lib/contacts/fields";
import { createClient } from "@/lib/supabase/server";
import { z } from "zod";

export const dynamic = "force-dynamic";

/** Teto por requisição — o cliente manda em lotes; evita estourar o tempo da função. */
const MAX_ROWS = 500;

/**
 * Schema propositalmente FROUXO: uma célula estranha numa linha não pode
 * derrubar o lote inteiro (422). O que não serve é descartado no `sanitize`
 * abaixo, respeitando os CHECKs da tabela (e-mail e telefone E.164).
 */
const importRowSchema = z.object({
  line: z.number().int().optional(),
  name: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  empreendimento: z.string().nullable().optional(),
});

const importSchema = z.object({
  rows: z.array(importRowSchema).min(1).max(MAX_ROWS),
});

type ImportRow = z.infer<typeof importRowSchema>;

const E164 = /^\+\d{8,15}$/; // contacts_phone_e164_format
const EMAIL = /^[^@\s;,]+@[^@\s;,]+\.[^@\s;,]+$/; // contacts_email_format

function sanitize(row: ImportRow): ImportRow {
  const text = (v: string | null | undefined, max: number): string | null => {
    const s = (v ?? "").trim();
    return s ? s.slice(0, max) : null;
  };
  const phone = text(row.phone, 20);
  const email = text(row.email, 200)?.toLowerCase() ?? null;
  return {
    line: row.line,
    name: text(row.name, 200),
    phone: phone && E164.test(phone) ? phone : null,
    email: email && EMAIL.test(email) ? email : null,
    empreendimento: text(row.empreendimento, 120),
  };
}

interface ExistingContact {
  id: string;
  phone_number: string | null;
  email_normalized: string | null;
  name: string | null;
  display_name: string | null;
  email: string | null;
  custom_fields: Record<string, unknown> | null;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const supabase = await createClient();

  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) return fail("unauthenticated", "Auth required.", 401, { requestId });

  const authUser = await loadAuthUser();
  const activeOrg = authUser ? await resolveActiveOrg(authUser) : null;
  if (!activeOrg) return fail("no_active_org", "No active organization.", 403, { requestId });
  if (!authUser?.is_platform_admin && ROLE_RANK[activeOrg.role] < ROLE_RANK.agent) {
    return fail("forbidden", "Sem permissão para importar contatos.", 403, { requestId });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("invalid_request", "JSON inválido.", 400, { requestId });
  }
  const parsed = importSchema.safeParse(body);
  if (!parsed.success) {
    return fail("validation_failed", "Payload inválido.", 422, {
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
      requestId,
    });
  }

  const orgId = activeOrg.orgId;
  const rows = parsed.data.rows.map(sanitize).filter((r) => r.name || r.phone || r.email);
  const errors: Array<{ line?: number; message: string }> = [];

  // --- 1. quem já existe (por telefone e por e-mail), em lotes ---------------
  const phones = Array.from(new Set(rows.map((r) => r.phone).filter((p): p is string => !!p)));
  const emails = Array.from(
    new Set(rows.map((r) => r.email?.toLowerCase()).filter((e): e is string => !!e)),
  );

  const existing: ExistingContact[] = [];
  const SELECT = "id, phone_number, email_normalized, name, display_name, email, custom_fields";
  for (const part of chunk(phones, 100)) {
    const { data, error } = await supabase
      .from("contacts")
      .select(SELECT)
      .eq("organization_id", orgId)
      .is("is_merged_into", null)
      .in("phone_number", part);
    if (error) return fail("internal_error", error.message, 500, { requestId });
    existing.push(...((data ?? []) as ExistingContact[]));
  }
  for (const part of chunk(emails, 100)) {
    const { data, error } = await supabase
      .from("contacts")
      .select(SELECT)
      .eq("organization_id", orgId)
      .is("is_merged_into", null)
      .in("email_normalized", part);
    if (error) return fail("internal_error", error.message, 500, { requestId });
    existing.push(...((data ?? []) as ExistingContact[]));
  }

  const byPhone = new Map<string, ExistingContact>();
  const byEmail = new Map<string, ExistingContact>();
  for (const c of existing) {
    if (c.phone_number) byPhone.set(c.phone_number, c);
    if (c.email_normalized) byEmail.set(c.email_normalized, c);
  }

  const match = (row: ImportRow): ExistingContact | undefined =>
    (row.phone ? byPhone.get(row.phone) : undefined) ??
    (row.email ? byEmail.get(row.email.toLowerCase()) : undefined);

  // --- 2. novos: insert em lote --------------------------------------------
  const toInsert = rows.filter((r) => !match(r));
  let created = 0;
  for (const part of chunk(toInsert, 100)) {
    const payload = part.map((r) => ({
      organization_id: orgId,
      created_by_user_id: user.id,
      name: r.name ?? null,
      display_name: r.name ?? null,
      email: r.email ?? null,
      phone_number: r.phone ?? null,
      tags: [] as string[],
      source: "import",
      source_metadata: { imported_at: new Date().toISOString() },
      consent: {},
      custom_fields: r.empreendimento ? { [CONTACT_FIELD.empreendimento]: r.empreendimento } : {},
    }));
    const { data, error } = await supabase.from("contacts").insert(payload).select("id");
    if (error) {
      errors.push({ message: `Lote de ${part.length} linhas falhou: ${error.message}` });
      continue;
    }
    created += (data ?? []).length;
  }

  // --- 3. existentes: só completa buraco (nunca sobrescreve) ----------------
  let updated = 0;
  let unchanged = 0;
  for (const row of rows) {
    const hit = match(row);
    if (!hit) continue;

    const patch: Record<string, unknown> = {};
    if (row.name && !hit.name) patch.name = row.name;
    if (row.name && !hit.display_name) patch.display_name = row.name;
    // `email_normalized` é coluna GERADA (lower(trim(email))) — gravar nela é erro.
    if (row.email && !hit.email) patch.email = row.email;
    if (row.phone && !hit.phone_number) patch.phone_number = row.phone;
    if (row.empreendimento) {
      const cf = (hit.custom_fields ?? {}) as Record<string, unknown>;
      if (!cf[CONTACT_FIELD.empreendimento]) {
        patch.custom_fields = { ...cf, [CONTACT_FIELD.empreendimento]: row.empreendimento };
      }
    }

    if (Object.keys(patch).length === 0) {
      unchanged++;
      continue;
    }
    patch.updated_at = new Date().toISOString();
    const { error } = await supabase
      .from("contacts")
      .update(patch)
      .eq("id", hit.id)
      .eq("organization_id", orgId);
    if (error) {
      errors.push({ line: row.line, message: error.message });
      continue;
    }
    updated++;
  }

  await audit({
    action: "contact.created",
    actorUserId: user.id,
    organizationId: orgId,
    resourceType: "contact",
    resourceId: null,
    requestId,
    metadata: {
      bulk_import: true,
      rows: rows.length,
      created,
      updated,
      unchanged,
      errors: errors.length,
    },
  });

  return ok({ created, updated, unchanged, errors }, { requestId });
}
