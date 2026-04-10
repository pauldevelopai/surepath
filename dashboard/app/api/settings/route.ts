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

  // Also update the surepath .env so the WhatsApp server picks it up
  try {
    const path = require("path");
    const envPath = path.resolve(process.cwd(), "..", ".env");
    let env = fs.readFileSync(envPath, "utf8");
    if (env.includes("REPORT_PRICE=")) {
      env = env.replace(/^REPORT_PRICE=.*/m, `REPORT_PRICE=${merged.report_price}`);
    } else {
      env += `\nREPORT_PRICE=${merged.report_price}`;
    }
    fs.writeFileSync(envPath, env);
  } catch {}

  return merged;
}

export const GET = withAuth(async () => {
  return NextResponse.json(loadSettings());
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

  const saved = saveSettings(settings);

  // Also update PAYMENT_ENABLED in .env
  try {
    const path = require("path");
    const envPath = path.resolve(process.cwd(), "..", ".env");
    let env = fs.readFileSync(envPath, "utf8");
    if (env.includes("PAYMENT_ENABLED=")) {
      env = env.replace(/^PAYMENT_ENABLED=.*/m, `PAYMENT_ENABLED=${saved.payment_enabled ? 'true' : 'false'}`);
    }
    fs.writeFileSync(envPath, env);
  } catch {}

  // Restart surepath to pick up changes
  try {
    const { execSync } = require("child_process");
    execSync("pm2 restart surepath --update-env", { timeout: 10000 });
  } catch {}

  return NextResponse.json({ ok: true, ...saved });
});
