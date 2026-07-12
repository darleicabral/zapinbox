"use server";

import QRCode from "qrcode";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

export type EnrollMfaResult =
  | { ok: true; factor_id: string; qr_data_url: string; uri: string; secret: string }
  | { ok: false; error: "enroll_failed"; message?: string };

/**
 * Starts a TOTP enrollment. Returns factor_id + QR data URL (PNG) + raw URI.
 * The factor remains in `unverified` status until the user submits a valid
 * 6-digit code via {@link confirmMfaEnroll}.
 *
 * If a previous unverified factor exists, we delete it first so the user can
 * re-scan a fresh QR.
 */
export async function enrollMfa(): Promise<EnrollMfaResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Drop any stale unverified TOTP factors (idempotent re-enroll).
  const { data: existing } = await supabase.auth.mfa.listFactors();
  for (const f of existing?.all ?? []) {
    if (f.factor_type === "totp" && f.status === "unverified") {
      await supabase.auth.mfa.unenroll({ factorId: f.id });
    }
  }

  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: "totp",
    friendlyName: `ZapInbox ${new Date().toISOString().slice(0, 10)}`,
  });
  if (error || !data) {
    return { ok: false, error: "enroll_failed", message: error?.message };
  }

  // supabase-js returns: { id, type: "totp", totp: { qr_code (svg string), uri, secret } }
  // We re-render the URI to a PNG data URL for predictable rendering.
  const uri = data.totp.uri;
  const qr_data_url = await QRCode.toDataURL(uri, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 240,
  });

  return {
    ok: true,
    factor_id: data.id,
    qr_data_url,
    uri,
    secret: data.totp.secret,
  };
}
