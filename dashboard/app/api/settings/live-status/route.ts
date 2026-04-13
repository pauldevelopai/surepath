import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import fs from "fs";

/**
 * Returns the EXACT settings the WhatsApp bot will use on its next message.
 * Reads the same /tmp/surepath-settings.json file that whatsapp.js reads,
 * plus checks that the selected provider has its credentials configured.
 */
export const GET = withAuth(async () => {
  const SETTINGS_FILE = "/tmp/surepath-settings.json";

  let settings: Record<string, unknown> = {};
  let fileMtime: string | null = null;
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, "utf8");
    settings = JSON.parse(raw);
    fileMtime = fs.statSync(SETTINGS_FILE).mtime.toISOString();
  } catch {
    // File not yet written — defaults apply
  }

  const provider = (settings.payment_provider as string) || "yoco";
  const paymentEnabled = settings.payment_enabled !== false;
  const price = Number(settings.report_price) || 169;

  // Check that the selected provider has working credentials
  const yocoConfigured = !!process.env.YOCO_SECRET_KEY;
  const payfastConfigured = !!process.env.PAYFAST_MERCHANT_ID && !!process.env.PAYFAST_MERCHANT_KEY;

  const providerReady =
    (provider === "yoco" && yocoConfigured) ||
    (provider === "payfast" && payfastConfigured);

  // Effective state — what the bot will actually do
  const effectiveBehaviour = !paymentEnabled
    ? "free_reports"
    : providerReady
    ? "charge_users"
    : "missing_credentials_will_fail";

  const resp = NextResponse.json({
    settings_file_path: SETTINGS_FILE,
    settings_file_last_written: fileMtime,
    payment_enabled: paymentEnabled,
    payment_provider: provider,
    report_price: price,
    yoco_configured: yocoConfigured,
    payfast_configured: payfastConfigured,
    provider_ready: providerReady,
    effective_behaviour: effectiveBehaviour,
    effective_message:
      effectiveBehaviour === "free_reports"
        ? "Income paused — reports are FREE. No payment link is sent to WhatsApp users."
        : effectiveBehaviour === "charge_users"
        ? `Live: WhatsApp users pay R${price} via ${provider === "yoco" ? "Yoco" : "PayFast"}. Link sent after tease.`
        : `WARNING: ${provider === "yoco" ? "Yoco" : "PayFast"} is selected but credentials are not configured. Payment flow will fail.`,
  });

  resp.headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
  return resp;
});
