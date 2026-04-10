import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import fs from "fs";

const SETTINGS_FILE = "/tmp/surepath-settings.json";

const DEFAULTS = {
  report_price: 169,
  payment_enabled: true,
};

function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings(settings: Record<string, unknown>) {
  const merged = { ...DEFAULTS, ...settings };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2));

  // Also update the surepath .env — remove ALL existing lines then append once
  try {
    const path = require("path");
    const envPath = path.resolve(process.cwd(), "..", ".env");
    let env = fs.readFileSync(envPath, "utf8");
    // Remove all existing REPORT_PRICE and PAYMENT_ENABLED lines (prevents duplicates)
    env = env.replace(/^REPORT_PRICE=.*\n?/gm, "");
    env = env.replace(/^PAYMENT_ENABLED=.*\n?/gm, "");
    // Remove trailing blank lines and append fresh values
    env = env.trimEnd() + "\n";
    env += `REPORT_PRICE=${merged.report_price}\n`;
    env += `PAYMENT_ENABLED=${merged.payment_enabled ? "true" : "false"}\n`;
    fs.writeFileSync(envPath, env);
  } catch {}

  return merged;
}

export const GET = withAuth(async () => {
  const resp = NextResponse.json(loadSettings());
  resp.headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
  return resp;
});

export const POST = withAuth(async (req: NextRequest) => {
  const body = await req.json();
  const settings = loadSettings();

  if (body.report_price !== undefined) {
    const price = parseInt(String(body.report_price));
    if (isNaN(price) || price < 0 || price > 10000) {
      return NextResponse.json({ error: "Price must be between 0 and 10,000" }, { status: 400 });
    }
    settings.report_price = price;
  }

  if (body.payment_enabled !== undefined) {
    settings.payment_enabled = !!body.payment_enabled;
  }

  if (body.payment_provider !== undefined) {
    settings.payment_provider = body.payment_provider === "payfast" ? "payfast" : "yoco";
  }

  const saved = saveSettings(settings);

  // saveSettings already updates .env — no need to restart since whatsapp.js
  // reads from /tmp/surepath-settings.json on every request

  return NextResponse.json({ ok: true, ...saved });
});
