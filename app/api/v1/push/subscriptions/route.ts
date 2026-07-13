/**
 * POST /api/v1/push/subscriptions — registra a assinatura Web Push do
 * usuário logado (upsert por endpoint; o mesmo aparelho re-registrando não
 * duplica). DELETE remove (body: { endpoint }).
 *
 * Escrita via cliente do usuário (RLS push_subscriptions_own garante que só
 * cria/apaga assinatura própria dentro de org da qual é membro).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const subscribeSchema = z.object({
  organization_id: z.string().uuid(),
  endpoint: z.string().url().max(1000),
  keys: z.object({
    p256dh: z.string().min(1).max(300),
    auth: z.string().min(1).max(100),
  }),
});

const unsubscribeSchema = z.object({
  endpoint: z.string().url().max(1000),
});

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const supabase = await createClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) return fail("unauthenticated", "Auth required.", 401, { requestId });

  let body;
  try {
    body = subscribeSchema.parse(await req.json());
  } catch {
    return fail("invalid_request", "Assinatura push inválida.", 422, { requestId });
  }

  const { error } = await supabase.from("push_subscriptions").upsert(
    {
      organization_id: body.organization_id,
      user_id: user.id,
      endpoint: body.endpoint,
      p256dh: body.keys.p256dh,
      auth: body.keys.auth,
      user_agent: req.headers.get("user-agent")?.slice(0, 300) ?? null,
    },
    { onConflict: "endpoint" },
  );
  if (error) return fail("internal_error", error.message, 500, { requestId });

  return ok({ subscribed: true }, { requestId });
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const supabase = await createClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) return fail("unauthenticated", "Auth required.", 401, { requestId });

  let body;
  try {
    body = unsubscribeSchema.parse(await req.json());
  } catch {
    return fail("invalid_request", "endpoint obrigatório.", 422, { requestId });
  }

  const { error } = await supabase
    .from("push_subscriptions")
    .delete()
    .eq("endpoint", body.endpoint)
    .eq("user_id", user.id);
  if (error) return fail("internal_error", error.message, 500, { requestId });

  return ok({ unsubscribed: true }, { requestId });
}
