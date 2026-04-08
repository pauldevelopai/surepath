import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import path from "path";

export const GET = withAuth(async () => {
  const results: Record<string, { status: string; message: string; action?: string }> = {};

  // Anthropic
  try {
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const client = new Anthropic();
    await client.messages.create({ model: "claude-3-haiku-20240307", max_tokens: 5, messages: [{ role: "user", content: "hi" }] });
    results.anthropic = { status: "ok", message: "Claude Haiku responding" };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("credit balance")) {
      results.anthropic = { status: "down", message: "No credits — add funds", action: "https://console.anthropic.com/settings/billing" };
    } else if (msg.includes("401") || msg.includes("auth")) {
      results.anthropic = { status: "down", message: "Invalid API key", action: "https://console.anthropic.com/settings/keys" };
    } else {
      results.anthropic = { status: "down", message: msg.substring(0, 100) };
    }
  }

  // Google Maps
  const mapsKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!mapsKey) {
    results.google_geocoding = { status: "down", message: "GOOGLE_MAPS_API_KEY not set" };
    results.google_streetview = { status: "down", message: "GOOGLE_MAPS_API_KEY not set" };
    results.google_satellite = { status: "down", message: "GOOGLE_MAPS_API_KEY not set" };
  } else {
    try {
      const mapsPath = path.resolve(process.cwd(), "..", "maps.js");
      const maps = await import(/* webpackIgnore: true */ mapsPath);
      const geocode = maps.geocode || maps.default?.geocode;
      const geo = geocode ? await geocode("Cape Town, South Africa") : null;
      results.google_geocoding = geo ? { status: "ok", message: "Geocoding working" } : { status: "down", message: "Geocoding failed", action: "https://console.cloud.google.com/apis/library" };
    } catch (err: unknown) {
      results.google_geocoding = { status: "down", message: (err instanceof Error ? err.message : "").substring(0, 80), action: "https://console.cloud.google.com/apis/credentials" };
    }
    // Don't test streetview/satellite live (costs money) — just check if key is set
    results.google_streetview = { status: mapsKey ? "configured" : "down", message: mapsKey ? "Key set — enable Street View Static API" : "Not configured" };
    results.google_satellite = { status: mapsKey ? "configured" : "down", message: mapsKey ? "Key set — enable Maps Static API" : "Not configured" };
  }

  // Twilio WhatsApp
  const twilioSid = process.env.TWILIO_ACCOUNT_SID;
  const twilioToken = process.env.TWILIO_AUTH_TOKEN;
  if (twilioSid && twilioToken) {
    try {
      const twilio = (await import("twilio")).default;
      const client = twilio(twilioSid, twilioToken);
      const account = await client.api.accounts(twilioSid).fetch();
      results.twilio = { status: account.status === "active" ? "ok" : "configured", message: `WhatsApp: ${process.env.TWILIO_WHATSAPP_NUMBER || "no number"} — ${account.status}` };
    } catch (err: unknown) {
      results.twilio = { status: "down", message: (err instanceof Error ? err.message : "").substring(0, 80), action: "https://console.twilio.com" };
    }
  } else {
    results.twilio = { status: "not_configured", message: "No Twilio credentials", action: "https://console.twilio.com" };
  }

  // Lightsail — check if we can reach ourselves (server health)
  try {
    const os = await import("os");
    const uptime = os.uptime();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const memUsedPct = Math.round((1 - freeMem / totalMem) * 100);
    const uptimeDays = Math.floor(uptime / 86400);
    const loadAvg = os.loadavg()[0].toFixed(2);
    results.lightsail = {
      status: memUsedPct > 90 ? "down" : "ok",
      message: `${uptimeDays}d uptime · ${memUsedPct}% RAM · load ${loadAvg} · $40/mo (2 vCPU, 4GB)`,
    };
  } catch {
    results.lightsail = { status: "ok", message: "Lightsail eu-west-2 · $40/mo" };
  }

  // Other services — check if keys are configured
  results.windeed = { status: process.env.WINDEED_API_KEY ? "configured" : "not_configured", message: process.env.WINDEED_API_KEY ? "Key set" : "No key — optional" };
  results.elevenlabs = { status: process.env.ELEVENLABS_API_KEY ? "configured" : "not_configured", message: process.env.ELEVENLABS_API_KEY ? "Key set" : "No key — optional" };
  results.heygen = { status: process.env.HEYGEN_API_KEY ? "configured" : "not_configured", message: process.env.HEYGEN_API_KEY ? "Key set" : "No key — optional" };

  return NextResponse.json(results);
});
