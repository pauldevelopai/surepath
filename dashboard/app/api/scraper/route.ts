import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { withAuth } from "@/lib/auth";
import { spawn } from "child_process";
import path from "path";

// Track running scraper process
let scraperProcess: ReturnType<typeof spawn> | null = null;
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
    scraper_running: scraperProcess !== null && !scraperProcess.killed,
    scraper_log: scraperLog.slice(-50),
  });
});

export const POST = withAuth(async (req: NextRequest) => {
  const { action, suburb, delay, max_pages, refresh, source, province, province_code, start_page } = await req.json();

  if (action === "start") {
    if (scraperProcess && !scraperProcess.killed) {
      return NextResponse.json({ ok: false, message: "Scraper already running" });
    }

    let args: string[];
    if (source === "pp") {
      // PrivateProperty scraper
      args = [path.resolve(process.cwd(), "..", "bootstrap", "scrape-pp.js")];
      if (province) args.push("--province", province);
      if (province_code) args.push("--code", String(province_code));
      if (start_page) args.push("--start-page", String(start_page));
    } else {
      // Property24 scraper
      args = [path.resolve(process.cwd(), "..", "bootstrap", "scrape-p24.js")];
      if (suburb) args.push("--suburb", suburb);
      if (refresh) args.push("--refresh");
    }
    if (delay) args.push("--delay", String(delay));
    if (max_pages) args.push("--max-pages", String(max_pages));

    scraperLog = [`Starting scraper: node ${args.join(" ")}`];

    scraperProcess = spawn("node", args, {
      cwd: path.resolve(process.cwd(), ".."),
      env: { ...process.env },
    });

    scraperProcess.stdout?.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n").filter(Boolean);
      scraperLog.push(...lines);
      if (scraperLog.length > 200) scraperLog = scraperLog.slice(-200);
    });

    scraperProcess.stderr?.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n").filter(Boolean);
      scraperLog.push(...lines.map(l => `[ERROR] ${l}`));
    });

    scraperProcess.on("close", (code: number) => {
      scraperLog.push(`Scraper exited with code ${code}`);
      scraperProcess = null;
    });

    return NextResponse.json({ ok: true, message: "Scraper started" });
  }

  if (action === "stop") {
    if (scraperProcess && !scraperProcess.killed) {
      scraperProcess.kill("SIGTERM");
      scraperLog.push("Scraper stopped by user");
      scraperProcess = null;
      return NextResponse.json({ ok: true, message: "Scraper stopped — will resume from where it left off" });
    }
    return NextResponse.json({ ok: false, message: "Scraper not running" });
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
    const buildPath = path.resolve(process.cwd(), "..", "bootstrap", "build-training-data.js");
    const proc = spawn("node", ["-e", `require('dotenv').config();require('${buildPath.replace(/'/g, "\\'")}').then?.(()=>process.exit(0))`], {
      cwd: path.resolve(process.cwd(), ".."),
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
