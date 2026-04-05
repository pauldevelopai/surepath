import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { withAuth } from "@/lib/auth";

/* eslint-disable @typescript-eslint/no-require-imports */
const path = require("path");
const cp = require("child_process");
/* eslint-enable @typescript-eslint/no-require-imports */

function getProjectRoot(): string { return path.resolve(process.cwd(), ".."); }
function spawn(cmd: string, args: string[], opts: Record<string, unknown>) { return cp.spawn(cmd, args, opts); }

/**
 * Run a backend collection script as a child process.
 * This avoids DB connection issues (backend modules use their own pool with dotenv).
 */
function runScript(scriptCode: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn("node", ["-e", scriptCode], {
      cwd: getProjectRoot(),
      env: { ...process.env, NODE_PATH: getProjectRoot() },
      timeout: 120000,
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => stdout += d);
    child.stderr.on("data", (d) => stderr += d);
    child.on("close", (code) => resolve({ stdout, stderr, code: code || 0 }));
  });
}

export const POST = withAuth(async (req: NextRequest) => {
  const { type, limit = 20 } = await req.json();
  const log: string[] = [];

  // ── Crime Data ──
  if (type === "crime" || type === "all") {
    const rows = await query(`
      SELECT p.id, p.suburb, p.city FROM properties p
      WHERE p.suburb IS NOT NULL AND p.city IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM area_risk_data ard WHERE ard.suburb ILIKE p.suburb AND ard.city ILIKE p.city AND ard.risk_type = 'crime_detailed')
      ORDER BY p.created_at DESC LIMIT $1`, [limit]);

    log.push(`Crime: ${rows.length} properties to process`);
    for (const prop of rows) {
      const script = `
        require('dotenv').config();
        const { collectForProperty } = require('./collect-crime');
        (async () => {
          try {
            const r = await collectForProperty(${prop.id});
            console.log(JSON.stringify(r));
          } catch(e) { console.log(JSON.stringify({ error: e.message })); }
          process.exit(0);
        })();
      `;
      const { stdout } = await runScript(script);
      try {
        const result = JSON.parse(stdout.trim().split("\n").pop() || "{}");
        if (result.station) {
          log.push(`OK: ${prop.suburb} → ${result.station} (${result.total} incidents)`);
        } else {
          log.push(`SKIP: ${prop.suburb} — ${result.error || "no data"}`);
        }
      } catch {
        log.push(`SKIP: ${prop.suburb} — ${stdout.trim().substring(0, 100) || "unknown error"}`);
      }
    }
    log.push(`Crime collection complete`);
  }

  // ── Solar Data ──
  if (type === "solar" || type === "all") {
    const rows = await query(`
      SELECT id, suburb, lat, lng FROM properties
      WHERE lat IS NOT NULL AND lng IS NOT NULL AND solar_ghi_kwh_year IS NULL
      ORDER BY created_at DESC LIMIT $1`, [limit]);

    log.push(`Solar: ${rows.length} properties to process`);
    for (const prop of rows) {
      const script = `
        require('dotenv').config();
        const mod = require('./collect-solar');
        (async () => {
          try {
            const fn = mod.collectForProperty || mod.getSolarData;
            const r = await fn(${prop.id});
            console.log(JSON.stringify(r));
          } catch(e) { console.log(JSON.stringify({ error: e.message })); }
          process.exit(0);
        })();
      `;
      const { stdout } = await runScript(script);
      try {
        const result = JSON.parse(stdout.trim().split("\n").pop() || "{}");
        if (result.ghi || result.ghi_kwh_m2_year) {
          log.push(`OK: ${prop.suburb || prop.id} → ${result.ghi || result.ghi_kwh_m2_year} kWh/m²/year`);
        } else {
          log.push(`SKIP: ${prop.suburb || prop.id} — ${result.error || "no data"}`);
        }
      } catch {
        log.push(`SKIP: ${prop.suburb || prop.id} — ${stdout.trim().substring(0, 100) || "unknown error"}`);
      }
    }
    log.push(`Solar collection complete`);
  }

  // ── PP Listing Discovery ──
  if (type === "discovery" || type === "all") {
    const suburbs = await query(`
      SELECT DISTINCT suburb, city, province FROM properties
      WHERE suburb IS NOT NULL AND city IS NOT NULL AND province IS NOT NULL
      ORDER BY suburb LIMIT $1`, [limit]);

    log.push(`Discovery: checking ${suburbs.length} suburbs for new PP listings`);
    let newFound = 0;

    for (const sub of suburbs) {
      const provinceSlug = (sub.province || "").toLowerCase().replace(/\s+/g, "-");
      const citySlug = (sub.city || "").toLowerCase().replace(/\s+/g, "-");
      const suburbSlug = (sub.suburb || "").toLowerCase().replace(/\s+/g, "-");
      if (!provinceSlug || !citySlug || !suburbSlug) continue;

      const script = `
        require('dotenv').config();
        const { searchPP } = require('./search-pp');
        (async () => {
          try {
            const r = await searchPP('${provinceSlug}', '${citySlug}', '${suburbSlug}', () => {});
            console.log(JSON.stringify({ listings: (r?.listings || []).map(l => ({ url: l.url, ppId: l.ppId })) }));
          } catch(e) { console.log(JSON.stringify({ error: e.message, listings: [] })); }
          process.exit(0);
        })();
      `;
      const { stdout } = await runScript(script);
      try {
        const result = JSON.parse(stdout.trim().split("\n").pop() || '{"listings":[]}');
        for (const listing of (result.listings || [])) {
          const existing = await query("SELECT id FROM properties WHERE erf_number = $1", [`PP_${listing.ppId}`]);
          if (existing.length === 0) {
            newFound++;
            log.push(`NEW: ${listing.ppId} in ${sub.suburb}`);
            await query(`INSERT INTO properties (erf_number, address_raw, suburb, city, province, listing_url)
              VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (erf_number) DO NOTHING`,
              [`PP_${listing.ppId}`, `Discovered in ${sub.suburb}`, sub.suburb, sub.city, sub.province, listing.url]);
          }
        }
      } catch {}
    }
    log.push(`Discovery complete: ${newFound} new listings found`);
  }

  return NextResponse.json({ ok: true, log });
});
