import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { withAuth } from "@/lib/auth";

/* eslint-disable @typescript-eslint/no-require-imports */
const cp = require("child_process");
const path = require("path");
/* eslint-enable @typescript-eslint/no-require-imports */

function getProjectDir(): string { return path.resolve(process.cwd(), ".."); }
function scriptPath(name: string): string { return path.join(getProjectDir(), "bootstrap", name); }
function spawn(cmd: string, args: string[], opts: Record<string, unknown>) { return cp.spawn(cmd, args, opts); }
function execSync(cmd: string, opts?: Record<string, unknown>) { return cp.execSync(cmd, opts); }

// Track running scraper processes — keyed by name (e.g. "pp", "p24", "pp_2")
const scraperProcesses: Map<string, { proc: ReturnType<typeof spawn>; log: string[]; startedAt: Date }> = new Map();
// Legacy single-process variables for backwards compat with GET
let scraperLog: string[] = [];

export const GET = withAuth(async () => {
  // Job summary by status
  const jobs = await query(`
    SELECT sj.*,
      (SELECT COUNT(*) FROM scrape_log sl WHERE sl.job_id = sj.id AND sl.status = 'success') AS success_count,
      (SELECT COUNT(*) FROM scrape_log sl WHERE sl.job_id = sj.id AND sl.status = 'failed') AS failed_count
    FROM scrape_jobs sj ORDER BY sj.status, sj.suburb_name
  `);

  const summary = await query(`
    SELECT status, COUNT(*) AS cnt, SUM(total_listings_stored) AS stored, SUM(total_pages_scraped) AS pages
    FROM scrape_jobs GROUP BY status ORDER BY status
  `);

  const totals = await query(`
    SELECT
      (SELECT COUNT(*) FROM properties) AS properties,
      (SELECT COUNT(*) FROM properties WHERE erf_number LIKE 'P24_%') AS p24_properties,
      (SELECT COUNT(*) FROM properties WHERE erf_number LIKE 'PP_%') AS pp_properties,
      (SELECT COUNT(*) FROM property_images) AS images,
      (SELECT COUNT(*) FROM training_data) AS training
  `);

  return NextResponse.json({
    jobs,
    summary,
    totals: totals[0],
    scraper_running: scraperProcesses.size > 0,
    scraper_processes: Array.from(scraperProcesses.entries()).map(([name, s]) => ({
      name, running: !s.proc.killed, started: s.startedAt, log_lines: s.log.length,
      log: s.log.slice(-50),
    })),
    scraper_log: scraperLog.slice(-50),
  });
});

export const POST = withAuth(async (req: NextRequest) => {
  const { action, suburb, delay, max_pages, refresh, source, province, province_code, start_page, name: stopName } = await req.json();

  // ─── Master scraper: run everything ──────────────────────────────
  if (action === "scrape_all") {
    // Check if already running
    const existing = scraperProcesses.get("master");
    if (existing && !existing.proc.killed) {
      return NextResponse.json({ ok: false, message: "Master scraper already running" });
    }
    // Also check via status file
    try {
      const fs = require("fs");
      const statusRaw = fs.readFileSync("/tmp/surepath-scraper-status.json", "utf8");
      const st = JSON.parse(statusRaw);
      if (st.running) {
        return NextResponse.json({ ok: false, message: "Master scraper already running (from previous session)" });
      }
    } catch {}

    const logLines: string[] = ["[master] Starting master scraper — all data types"];
    scraperLog.push(...logLines);

    const proc = spawn("node", ["scrape-all.js"], {
      cwd: getProjectDir(),
      env: { ...process.env, FORCE_COLOR: "0" },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    scraperProcesses.set("master", { proc, log: logLines, startedAt: new Date() });

    proc.stdout?.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n").filter(Boolean).map(l => `[master] ${l}`);
      const entry = scraperProcesses.get("master");
      if (entry) { entry.log.push(...lines); if (entry.log.length > 500) entry.log = entry.log.slice(-500); }
      scraperLog.push(...lines);
      if (scraperLog.length > 500) scraperLog = scraperLog.slice(-500);
    });
    proc.stderr?.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n").filter(Boolean).map(l => `[master] [ERROR] ${l}`);
      const entry = scraperProcesses.get("master");
      if (entry) entry.log.push(...lines);
    });
    proc.on("close", () => { scraperProcesses.delete("master"); });
    proc.unref();

    return NextResponse.json({ ok: true, message: "Master scraper started — scraping all data types continuously" });
  }

  // ─── Stop master scraper ──────────────────────────────────────────
  if (action === "stop_all_scraping") {
    const fs = require("fs");
    fs.writeFileSync("/tmp/surepath-scraper-stop", new Date().toISOString());
    // Also kill the process if we have it
    const master = scraperProcesses.get("master");
    if (master && !master.proc.killed) {
      master.proc.kill("SIGTERM");
      scraperProcesses.delete("master");
    }
    return NextResponse.json({ ok: true, message: "Stop signal sent — scraper will finish current item and stop" });
  }

  // ─── Get master scraper status ────────────────────────────────────
  if (action === "scraper_status") {
    try {
      const fs = require("fs");
      const raw = fs.readFileSync("/tmp/surepath-scraper-status.json", "utf8");
      return NextResponse.json(JSON.parse(raw));
    } catch {
      return NextResponse.json({ running: false, scrapers: {} });
    }
  }

  if (action === "start") {
    // Determine scraper name and command based on source
    let scraperName: string;
    let args: string[];
    const projectDir = getProjectDir();

    if (source === "pp") {
      scraperName = "pp";
      args = [scriptPath("scrape-pp.js")];
      if (province) args.push("--province", province);
      if (province_code) args.push("--code", String(province_code));
      args.push("--start-page", String(start_page || 1));
      args.push("--delay", String(delay || 3));
      args.push("--max-pages", String(max_pages || 500));
      args.push("--no-stop");
    } else if (source === "crime") {
      scraperName = "crime";
      args = ["-e", `
        require('dotenv').config();
        const pool = require('./db');
        const { collectForProperty } = require('./collect-crime');
        function withTimeout(fn, ms) { return Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]); }
        (async () => {
          const { rows } = await pool.query(
            "SELECT DISTINCT ON (p.suburb, p.city) p.id, p.suburb, p.city FROM properties p WHERE p.suburb IS NOT NULL AND p.city IS NOT NULL AND NOT EXISTS (SELECT 1 FROM area_risk_data ard WHERE ard.suburb ILIKE p.suburb AND ard.city ILIKE p.city AND ard.risk_type = 'crime_detailed') ORDER BY p.suburb, p.city, p.created_at DESC LIMIT 30"
          );
          console.log('Crime: ' + rows.length + ' suburbs to process');
          let ok = 0, skip = 0;
          for (const prop of rows) {
            try {
              const r = await withTimeout(() => collectForProperty(prop.id), 15000);
              if (r?.station) { console.log('OK: ' + prop.suburb + ', ' + prop.city + ' → ' + r.station); ok++; }
              else { console.log('SKIP: ' + prop.suburb + ' — ' + (r?.error || 'no data')); skip++; }
            } catch (e) { console.log('SKIP: ' + prop.suburb + ' — ' + e.message); skip++; }
          }
          console.log('=== Crime complete: ' + ok + ' OK, ' + skip + ' skipped ===');
          await pool.end();
        })();
      `];
    } else if (source === "solar") {
      scraperName = "solar";
      args = ["-e", `
        require('dotenv').config();
        const pool = require('./db');
        const mod = require('./collect-solar');
        const fn = mod.collectForProperty || mod.getSolarData;
        (async () => {
          const { rows } = await pool.query(
            "SELECT id, suburb FROM properties WHERE lat IS NOT NULL AND lng IS NOT NULL AND solar_ghi_kwh_year IS NULL ORDER BY created_at DESC LIMIT 50"
          );
          console.log('Solar: ' + rows.length + ' properties to process (only geocoded properties)');
          if (rows.length === 0) console.log('No properties with coordinates pending solar data. Properties get geocoded when a report is generated.');
          for (const prop of rows) {
            try {
              const r = await fn(prop.id);
              if (r?.ghi_kwh_m2_year || r?.ghi) console.log('OK: ' + (prop.suburb || prop.id) + ' → ' + (r.ghi_kwh_m2_year || r.ghi) + ' kWh/m²/year');
              else console.log('SKIP: ' + (prop.suburb || prop.id) + ' — ' + (r?.error || 'no data'));
            } catch (e) { console.log('ERROR: ' + (prop.suburb || prop.id) + ' — ' + e.message); }
          }
          console.log('=== Solar collection complete ===');
          await pool.end();
        })();
      `];
    } else if (source === "discovery") {
      scraperName = "discovery";
      args = [scriptPath("scrape-pp.js"), "--max-pages", "20", "--delay", "2"];
    } else if (source === "saps") {
      scraperName = "saps";
      args = [scriptPath("scrape-saps-stations.js"), "--delay", "2"];
    } else if (source === "assist247") {
      scraperName = "assist247";
      args = [scriptPath("scrape-assist247.js"), "--delay", "3"];
    } else if (source === "procompare") {
      scraperName = "procompare";
      args = [scriptPath("scrape-procompare.js"), "--delay", "3"];
    } else if (source === "gvr") {
      scraperName = "gvr";
      args = ["-e", `
        require('dotenv').config();
        const { collectAllGVRs } = require('./collect-gvr');
        (async () => {
          console.log('GVR: Starting municipal valuation roll collection for all metros...');
          try {
            const result = await collectAllGVRs();
            console.log('=== GVR complete: ' + JSON.stringify(result) + ' ===');
          } catch (e) { console.error('GVR failed:', e.message); }
          process.exit(0);
        })();
      `];
    } else if (source === "schools") {
      scraperName = "schools";
      args = ["-e", `
        require('dotenv').config();
        const pool = require('./db');
        const { collectForProperty } = require('./collect-schools');
        (async () => {
          const { rows } = await pool.query(
            "SELECT DISTINCT ON (p.suburb, p.city) p.id, p.suburb, p.city FROM properties p WHERE p.lat IS NOT NULL AND p.suburb IS NOT NULL AND NOT EXISTS (SELECT 1 FROM area_risk_data ard WHERE ard.suburb ILIKE p.suburb AND ard.city ILIKE p.city AND ard.risk_type = 'school_proximity') ORDER BY p.suburb, p.city, p.created_at DESC LIMIT 20"
          );
          console.log('Schools: ' + rows.length + ' suburbs to process');
          for (const prop of rows) {
            try { await collectForProperty(prop.id); } catch (e) { console.log('ERROR: ' + prop.suburb + ' — ' + e.message); }
            await new Promise(r => setTimeout(r, 1000));
          }
          console.log('=== Schools complete ===');
          await pool.end();
        })();
      `];
    } else if (source === "climate") {
      scraperName = "climate";
      args = ["-e", `
        require('dotenv').config();
        const pool = require('./db');
        const { collectForProperty } = require('./collect-climate');
        (async () => {
          const { rows } = await pool.query(
            "SELECT DISTINCT ON (p.suburb, p.city) p.id, p.suburb, p.city FROM properties p WHERE p.lat IS NOT NULL AND p.suburb IS NOT NULL AND NOT EXISTS (SELECT 1 FROM area_risk_data ard WHERE ard.suburb ILIKE p.suburb AND ard.city ILIKE p.city AND ard.risk_type = 'climate') ORDER BY p.suburb, p.city, p.created_at DESC LIMIT 30"
          );
          console.log('Climate: ' + rows.length + ' suburbs to process');
          for (const prop of rows) {
            try { await collectForProperty(prop.id); } catch (e) { console.log('ERROR: ' + prop.suburb + ' — ' + e.message); }
            await new Promise(r => setTimeout(r, 500));
          }
          console.log('=== Climate complete ===');
          await pool.end();
        })();
      `];
    } else if (source === "loadshedding") {
      scraperName = "loadshedding";
      args = ["-e", `
        require('dotenv').config();
        const pool = require('./db');
        const { collectForProperty } = require('./collect-loadshedding');
        (async () => {
          const { rows } = await pool.query(
            "SELECT DISTINCT ON (p.suburb, p.city) p.id, p.suburb, p.city FROM properties p WHERE p.lat IS NOT NULL AND p.suburb IS NOT NULL AND NOT EXISTS (SELECT 1 FROM area_risk_data ard WHERE ard.suburb ILIKE p.suburb AND ard.city ILIKE p.city AND ard.risk_type = 'loadshedding') ORDER BY p.suburb, p.city, p.created_at DESC LIMIT 20"
          );
          console.log('Load Shedding: ' + rows.length + ' suburbs to process');
          for (const prop of rows) {
            try { await collectForProperty(prop.id); } catch (e) { console.log('ERROR: ' + prop.suburb + ' — ' + e.message); }
            await new Promise(r => setTimeout(r, 2000));
          }
          console.log('=== Load Shedding complete ===');
          await pool.end();
        })();
      `];
    } else if (source === "soldprices") {
      scraperName = "soldprices";
      args = ["-e", `
        require('dotenv').config();
        const pool = require('./db');
        const { collectForProperty } = require('./collect-sold-prices');
        (async () => {
          const { rows } = await pool.query(
            "SELECT DISTINCT ON (p.suburb, p.city) p.id, p.suburb, p.city FROM properties p WHERE p.suburb IS NOT NULL AND NOT EXISTS (SELECT 1 FROM area_risk_data ard WHERE ard.suburb ILIKE p.suburb AND ard.city ILIKE p.city AND ard.risk_type = 'sold_prices') ORDER BY p.suburb, p.city, p.created_at DESC LIMIT 15"
          );
          console.log('Sold Prices: ' + rows.length + ' suburbs to process');
          for (const prop of rows) {
            try { await collectForProperty(prop.id); } catch (e) { console.log('ERROR: ' + prop.suburb + ' — ' + e.message); }
            await new Promise(r => setTimeout(r, 3000));
          }
          console.log('=== Sold Prices complete ===');
          await pool.end();
        })();
      `];
    } else if (source === "fibre") {
      scraperName = "fibre";
      args = ["-e", `
        require('dotenv').config();
        const pool = require('./db');
        const { collectForProperty } = require('./collect-fibre');
        (async () => {
          const { rows } = await pool.query(
            "SELECT DISTINCT ON (p.suburb, p.city) p.id, p.suburb, p.city FROM properties p WHERE p.lat IS NOT NULL AND p.suburb IS NOT NULL AND NOT EXISTS (SELECT 1 FROM area_risk_data ard WHERE ard.suburb ILIKE p.suburb AND ard.city ILIKE p.city AND ard.risk_type = 'fibre_coverage') ORDER BY p.suburb, p.city, p.created_at DESC LIMIT 20"
          );
          console.log('Fibre: ' + rows.length + ' suburbs to process');
          for (const prop of rows) {
            try { await collectForProperty(prop.id); } catch (e) { console.log('ERROR: ' + prop.suburb + ' — ' + e.message); }
            await new Promise(r => setTimeout(r, 1000));
          }
          console.log('=== Fibre complete ===');
          await pool.end();
        })();
      `];
    } else if (source === "water") {
      scraperName = "water";
      args = ["-e", `
        require('dotenv').config();
        const pool = require('./db');
        const { collectForProperty } = require('./collect-municipal');
        (async () => {
          const { rows } = await pool.query(
            "SELECT DISTINCT ON (p.city) p.id, p.city FROM properties p WHERE p.city IS NOT NULL AND p.water_quality_score IS NULL ORDER BY p.city, p.created_at DESC LIMIT 30"
          );
          console.log('Water Quality: ' + rows.length + ' cities to process');
          let ok = 0, skip = 0;
          for (const prop of rows) {
            try {
              const r = await collectForProperty(prop.id);
              if (r?.water_quality_score) { console.log('OK: ' + prop.city + ' → water ' + r.water_quality_score + '/10, sewerage ' + (r.sewerage_quality_score || '?') + '/10'); ok++; }
              else { console.log('SKIP: ' + prop.city + ' — not in DWS dataset'); skip++; }
            } catch (e) { console.log('ERROR: ' + prop.city + ' — ' + e.message); skip++; }
          }
          console.log('=== Water Quality complete: ' + ok + ' OK, ' + skip + ' skipped ===');
          await pool.end();
        })();
      `];
    } else if (source === "electricity") {
      scraperName = "electricity";
      args = ["-e", `
        require('dotenv').config();
        const pool = require('./db');
        const { collectForProperty } = require('./collect-electricity');
        (async () => {
          const { rows } = await pool.query(
            "SELECT DISTINCT ON (p.city) p.id, p.city FROM properties p WHERE p.city IS NOT NULL AND NOT EXISTS (SELECT 1 FROM area_risk_data ard WHERE ard.city ILIKE p.city AND ard.risk_type = 'electricity') ORDER BY p.city, p.created_at DESC LIMIT 30"
          );
          console.log('Electricity: ' + rows.length + ' cities to process');
          for (const prop of rows) {
            try { await collectForProperty(prop.id); } catch (e) { console.log('ERROR: ' + prop.city + ' — ' + e.message); }
          }
          console.log('=== Electricity complete ===');
          await pool.end();
        })();
      `];
    } else if (source === "knowledge") {
      scraperName = "knowledge";
      args = ["-e", `
        require('dotenv').config();
        const pool = require('./db');
        const { collectKnowledge } = require('./collect-knowledge');
        (async () => {
          console.log('Knowledge: Starting SA construction & property knowledge collection...');
          try {
            const result = await collectKnowledge();
            console.log('=== Knowledge complete: ' + result.created + ' entries created, ' + result.skipped + ' duplicates, ' + result.errors + ' errors ===');
          } catch (e) { console.error('Knowledge collection failed:', e.message); }
          await pool.end();
          process.exit(0);
        })();
      `];
    } else {
      scraperName = `p24${suburb ? '_' + suburb.substring(0, 15) : ''}`;
      args = [scriptPath("scrape-p24.js")];
      if (suburb) args.push("--suburb", suburb);
      if (refresh) args.push("--refresh");
      if (delay) args.push("--delay", String(delay));
      if (max_pages) args.push("--max-pages", String(max_pages));
    }

    // Check if same scraper is already running (in-memory check)
    const existing = scraperProcesses.get(scraperName);
    if (existing && !existing.proc.killed) {
      return NextResponse.json({ ok: false, message: `"${scraperName}" already running` });
    }
    // Also check system processes (survives Next.js hot reload)
    if (scraperName === "pp") {
      try {
        const ps = execSync("ps aux | grep 'scrape-pp.js' | grep -v grep", { encoding: "utf8" });
        if (ps.trim()) {
          return NextResponse.json({ ok: false, message: `PP scraper already running (system process)` });
        }
      } catch { /* no process found — OK to start */ }
    }

    const logLines: string[] = [`[${scraperName}] Starting: node ${args.join(" ")}`];
    scraperLog.push(...logLines);

    const proc = spawn("node", args, {
      cwd: getProjectDir(),
      env: { ...process.env, FORCE_COLOR: "0" },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    scraperProcesses.set(scraperName, { proc, log: logLines, startedAt: new Date() });

    proc.stdout?.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n").filter(Boolean).map(l => `[${scraperName}] ${l}`);
      const entry = scraperProcesses.get(scraperName);
      if (entry) { entry.log.push(...lines); if (entry.log.length > 200) entry.log = entry.log.slice(-200); }
      scraperLog.push(...lines);
      if (scraperLog.length > 500) scraperLog = scraperLog.slice(-500);
    });

    proc.stderr?.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n").filter(Boolean).map(l => `[${scraperName}] [ERROR] ${l}`);
      const entry = scraperProcesses.get(scraperName);
      if (entry) entry.log.push(...lines);
      scraperLog.push(...lines);
    });

    proc.on("close", (code: number) => {
      const msg = `[${scraperName}] Exited with code ${code}`;
      scraperLog.push(msg);
      scraperProcesses.delete(scraperName);
    });

    // Detach so it runs independently of the HTTP request
    proc.unref();

    const running = Array.from(scraperProcesses.keys());
    return NextResponse.json({ ok: true, message: `Scraper "${scraperName}" started (${running.length} running: ${running.join(", ")})` });
  }

  if (action === "stop") {
    const name = stopName || null;
    if (name) {
      // Stop specific scraper
      const entry = scraperProcesses.get(name);
      if (entry && !entry.proc.killed) {
        entry.proc.kill("SIGTERM");
        scraperLog.push(`[${name}] Stopped by user`);
        scraperProcesses.delete(name);
        return NextResponse.json({ ok: true, message: `Scraper "${name}" stopped` });
      }
      return NextResponse.json({ ok: false, message: `Scraper "${name}" not running` });
    }
    // Stop all
    let stopped = 0;
    for (const [n, entry] of scraperProcesses) {
      if (!entry.proc.killed) { entry.proc.kill("SIGTERM"); stopped++; }
      scraperLog.push(`[${n}] Stopped by user`);
    }
    scraperProcesses.clear();
    return NextResponse.json({ ok: true, message: `Stopped ${stopped} scraper(s)` });
  }

  if (action === "reset_blocked") {
    await query("UPDATE scrape_jobs SET status = 'pending' WHERE status = 'blocked'");
    return NextResponse.json({ ok: true, message: "Blocked jobs reset to pending" });
  }

  if (action === "reset_job") {
    await query("UPDATE scrape_jobs SET status = 'pending', last_page_scraped = 0, total_pages_scraped = 0, total_listings_found = 0, total_listings_stored = 0, total_listings_skipped = 0 WHERE suburb_name = $1", [suburb]);
    return NextResponse.json({ ok: true, message: `Reset ${suburb}` });
  }

  if (action === "build_training") {
    const buildPath = scriptPath("build-training-data.js");
    const proc = spawn("node", ["-e", `require('dotenv').config();require('${buildPath.replace(/'/g, "\\'")}').then?.(()=>process.exit(0))`], {
      cwd: getProjectDir(),
      env: { ...process.env },
    });

    // Actually just run inline
    try {
      // Quick inline version
      const properties = await query(`
        SELECT p.*, pr.insurance_risk_score, pr.solar_suitability_score, pr.crime_risk_score,
               pr.asbestos_risk, pr.maintenance_cost_estimate, pr.decision, pr.vision_findings, pr.repair_estimates
        FROM properties p LEFT JOIN property_reports pr ON pr.property_id = p.id AND pr.status = 'complete'
      `);

      let count = 0;
      for (const p of properties) {
        const dom = p.listing_date ? Math.floor((Date.now() - new Date(p.listing_date).getTime()) / 86400000) : null;
        const findings = Array.isArray(p.vision_findings) ? p.vision_findings : [];
        const important = [p.asking_price, p.floor_area_sqm, p.bedrooms, p.bathrooms, p.property_type, p.suburb, p.city, p.lat, p.description, p.levies, p.rates_and_taxes, p.agent_name, p.listing_date];
        const completeness = Math.round((important.filter(Boolean).length / important.length) * 100) / 100;

        await query(`
          INSERT INTO training_data (property_id, price_zar, price_per_sqm, floor_area_sqm, stand_size_sqm,
            bedrooms, bathrooms, parking_total, levies_monthly, rates_monthly, days_on_market,
            suburb, city, property_type, pet_friendly, furnished,
            has_pool, has_garden, has_braai, has_balcony, has_aircon, has_security, airbnb_friendly,
            crime_score, insurance_risk_score, solar_suitability_score, asbestos_risk,
            total_findings, critical_findings, repair_cost_max, decision, data_completeness, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,NOW())
          ON CONFLICT (property_id) DO UPDATE SET
            price_zar=EXCLUDED.price_zar, price_per_sqm=EXCLUDED.price_per_sqm,
            floor_area_sqm=EXCLUDED.floor_area_sqm, bedrooms=EXCLUDED.bedrooms, bathrooms=EXCLUDED.bathrooms,
            days_on_market=EXCLUDED.days_on_market, total_findings=EXCLUDED.total_findings,
            critical_findings=EXCLUDED.critical_findings, decision=EXCLUDED.decision,
            data_completeness=EXCLUDED.data_completeness, updated_at=NOW()`,
          [p.id, p.asking_price, p.asking_price && p.floor_area_sqm ? Math.round(p.asking_price / p.floor_area_sqm) : null,
           p.floor_area_sqm, p.stand_size_sqm, p.bedrooms, p.bathrooms,
           (p.parking_spaces || 0) + (p.garages || 0), p.levies, p.rates_and_taxes, dom,
           p.suburb, p.city, p.property_type, p.pet_friendly || false, p.furnished || false,
           p.has_pool || false, p.has_garden || false, p.has_braai || false,
           p.has_balcony || false, p.has_aircon || false,
           p.has_alarm || p.has_electric_fence || p.security_visible || false,
           p.airbnb_friendly || false,
           p.suburb_crime_score, p.insurance_risk_score, p.solar_suitability_score, p.asbestos_risk,
           findings.length, findings.filter((f: { severity: string }) => f.severity === "CRITICAL" || f.severity === "HIGH").length,
           p.repair_estimates?.total_max_zar || null, p.decision, completeness]);
        count++;
      }
      proc.kill();
      return NextResponse.json({ ok: true, message: `Updated ${count} training records` });
    } catch (err: unknown) {
      proc.kill();
      return NextResponse.json({ ok: false, message: err instanceof Error ? err.message : String(err) });
    }
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
});
