import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import path from "path";
import fs from "fs";

const NUMBERS_FILE = "/tmp/surepath-active-number.json";

// All available WhatsApp numbers
const AVAILABLE_NUMBERS = [
  { number: "+27792198649", label: "Develop Audio" },
  { number: "+27625792969", label: "Develop AI" },
];

function getActiveNumber(): string {
  try {
    const data = JSON.parse(fs.readFileSync(NUMBERS_FILE, "utf8"));
    return data.number || process.env.TWILIO_WHATSAPP_NUMBER || AVAILABLE_NUMBERS[0].number;
  } catch {
    return process.env.TWILIO_WHATSAPP_NUMBER || AVAILABLE_NUMBERS[0].number;
  }
}

function setActiveNumber(number: string) {
  fs.writeFileSync(NUMBERS_FILE, JSON.stringify({ number, switched_at: new Date().toISOString() }));
  // Also update the environment variable for the running process
  process.env.TWILIO_WHATSAPP_NUMBER = number;
}

export const GET = withAuth(async () => {
  return NextResponse.json({
    active: getActiveNumber(),
    available: AVAILABLE_NUMBERS,
  });
});

export const POST = withAuth(async (req: NextRequest) => {
  const { action, number } = await req.json();

  if (action === "switch") {
    const valid = AVAILABLE_NUMBERS.find(n => n.number === number);
    if (!valid) return NextResponse.json({ error: "Invalid number" }, { status: 400 });

    setActiveNumber(number);

    // Also update the surepath server's env by writing to a shared file
    // The surepath server reads this on each message send
    const envPath = path.resolve(process.cwd(), "..", ".env");
    try {
      let env = fs.readFileSync(envPath, "utf8");
      env = env.replace(/^TWILIO_WHATSAPP_NUMBER=.*/m, `TWILIO_WHATSAPP_NUMBER=${number}`);
      fs.writeFileSync(envPath, env);
    } catch (e) {
      return NextResponse.json({ ok: false, message: `Switched in dashboard but failed to update .env: ${(e as Error).message}`, numbers: { active: number, available: AVAILABLE_NUMBERS } });
    }

    // Restart the surepath server to pick up the new number
    try {
      const { execSync } = require("child_process");
      execSync("pm2 restart surepath", { timeout: 10000 });
    } catch {}

    return NextResponse.json({
      ok: true,
      message: `Switched to ${number} (${valid.label}). Server restarted.`,
      numbers: { active: number, available: AVAILABLE_NUMBERS },
    });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
});
