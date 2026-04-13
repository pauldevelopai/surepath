import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { withAuth } from "@/lib/auth";

export const maxDuration = 60;

// All scrapers known to the system. Scheduled tier matches bootstrap/run-scheduled-scrapers.js.
const SCHEDULED_DAILY = ["articles", "crime", "loadshedding"];
const SCHEDULED_WEEKLY_SUNDAY = ["pexels", "mixkit", "unsplash", "soldprices", "pricetrends"];
const SCHEDULED_MONTHLY = ["schools", "climate", "fibre", "electricity", "solar"];

async function ensureTables() {
  await query(`
    CREATE TABLE IF NOT EXISTS scraper_runs (
      id SERIAL PRIMARY KEY,
      run_type TEXT NOT NULL,
      trigger TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'running',
      total_collected INTEGER DEFAULT 0,
      total_errors INTEGER DEFAULT 0,
      notes TEXT
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_scraper_runs_started ON scraper_runs(started_at DESC)`);
  await query(`
    CREATE TABLE IF NOT EXISTS scraper_run_items (
      id SERIAL PRIMARY KEY,
      run_id INTEGER REFERENCES scraper_runs(id) ON DELETE CASCADE,
      scraper_name TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      duration_seconds INTEGER,
      collected INTEGER DEFAULT 0,
      errors INTEGER DEFAULT 0,
      status TEXT DEFAULT 'running',
      error_sample TEXT
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_scraper_run_items_run ON scraper_run_items(run_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_scraper_run_items_name_started ON scraper_run_items(scraper_name, started_at DESC)`);
}

type ScraperItemSummary = {
  scraper_name: string;
  collected: number;
  errors: number;
  duration_seconds: number | null;
  status: string;
  error_sample: string | null;
  started_at: string;
};

function expectedScrapersFor(date: Date): string[] {
  const dow = date.getUTCDay();
  const dom = date.getUTCDate();
  const expected = [...SCHEDULED_DAILY];
  if (dow === 0) expected.push(...SCHEDULED_WEEKLY_SUNDAY);
  if (dom >= 1 && dom <= SCHEDULED_MONTHLY.length) expected.push(SCHEDULED_MONTHLY[dom - 1]);
  return expected;
}

export const GET = withAuth(async (req: NextRequest) => {
  await ensureTables();

  const url = new URL(req.url);
  const wantSuggestions = url.searchParams.get("suggestions") === "1";

  // "Last night" window: from 18:00 yesterday to now
  const now = new Date();
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const lastNightRuns = await query(
    `SELECT id, run_type, trigger, started_at, completed_at, status, total_collected, total_errors, notes
     FROM scraper_runs WHERE started_at >= $1 ORDER BY started_at DESC`,
    [since.toISOString()]
  );

  const runIds = lastNightRuns.map((r) => r.id);
  const items: ScraperItemSummary[] = runIds.length
    ? await query(
        `SELECT scraper_name, collected, errors, duration_seconds, status, error_sample, started_at
         FROM scraper_run_items WHERE run_id = ANY($1::int[]) ORDER BY started_at`,
        [runIds]
      )
    : [];

  // Aggregate by scraper for last night
  const perScraper = new Map<string, { collected: number; errors: number; duration: number; statuses: string[]; lastError: string | null }>();
  for (const it of items) {
    const key = it.scraper_name;
    const e = perScraper.get(key) || { collected: 0, errors: 0, duration: 0, statuses: [], lastError: null };
    e.collected += it.collected || 0;
    e.errors += it.errors || 0;
    e.duration += it.duration_seconds || 0;
    e.statuses.push(it.status);
    if (it.error_sample) e.lastError = it.error_sample;
    perScraper.set(key, e);
  }

  const lastNight = Array.from(perScraper.entries()).map(([name, v]) => ({
    scraper: name,
    collected: v.collected,
    errors: v.errors,
    duration_seconds: v.duration,
    status: v.statuses.includes("failed") ? "failed"
          : v.statuses.includes("timeout") ? "timeout"
          : v.statuses.includes("partial") ? "partial"
          : v.statuses.every((s) => s === "empty") ? "empty"
          : "success",
    last_error: v.lastError,
  })).sort((a, b) => b.errors - a.errors || b.collected - a.collected);

  // Scheduled-but-didn't-run gaps
  const expected = expectedScrapersFor(now);
  const ran = new Set(lastNight.map((x) => x.scraper));
  const gaps = expected.filter((s) => !ran.has(s));

  // 7-day underperformers: high error rate or zero collection
  const weekStats = await query(
    `SELECT scraper_name,
            COUNT(*) AS runs,
            SUM(collected)::int AS collected,
            SUM(errors)::int AS errors,
            SUM(CASE WHEN status IN ('failed','timeout') THEN 1 ELSE 0 END)::int AS fail_runs,
            SUM(CASE WHEN status = 'empty' THEN 1 ELSE 0 END)::int AS empty_runs,
            MAX(started_at) AS last_seen
       FROM scraper_run_items
      WHERE started_at >= NOW() - INTERVAL '7 days'
      GROUP BY scraper_name`
  );

  const underperformers = weekStats
    .map((r) => {
      const runs = parseInt(r.runs);
      const failRate = runs > 0 ? parseInt(r.fail_runs) / runs : 0;
      const emptyRate = runs > 0 ? parseInt(r.empty_runs) / runs : 0;
      return {
        scraper: r.scraper_name,
        runs,
        collected: parseInt(r.collected || 0),
        errors: parseInt(r.errors || 0),
        fail_rate: Math.round(failRate * 100),
        empty_rate: Math.round(emptyRate * 100),
        last_seen: r.last_seen,
      };
    })
    .filter((x) => x.fail_rate >= 25 || (x.runs >= 3 && x.collected === 0))
    .sort((a, b) => b.fail_rate - a.fail_rate);

  // Pending backlog snapshot — helps spot gaps in coverage
  const backlog = await query(`
    SELECT 'crime' AS type, COUNT(DISTINCT (p.suburb || '|' || p.city))::int AS pending FROM properties p WHERE p.suburb IS NOT NULL AND p.city IS NOT NULL AND NOT EXISTS (SELECT 1 FROM area_risk_data ard WHERE ard.suburb ILIKE p.suburb AND ard.city ILIKE p.city AND ard.risk_type = 'crime_detailed')
    UNION ALL SELECT 'solar', COUNT(*)::int FROM properties WHERE lat IS NOT NULL AND solar_ghi_kwh_year IS NULL
    UNION ALL SELECT 'climate', COUNT(DISTINCT (p.suburb || '|' || p.city))::int FROM properties p WHERE p.lat IS NOT NULL AND p.suburb IS NOT NULL AND NOT EXISTS (SELECT 1 FROM area_risk_data ard WHERE ard.suburb ILIKE p.suburb AND ard.city ILIKE p.city AND ard.risk_type = 'climate')
    UNION ALL SELECT 'schools', COUNT(DISTINCT (p.suburb || '|' || p.city))::int FROM properties p WHERE p.lat IS NOT NULL AND p.suburb IS NOT NULL AND NOT EXISTS (SELECT 1 FROM area_risk_data ard WHERE ard.suburb ILIKE p.suburb AND ard.city ILIKE p.city AND ard.risk_type = 'school_proximity')
    UNION ALL SELECT 'fibre', COUNT(DISTINCT (p.suburb || '|' || p.city))::int FROM properties p WHERE p.suburb IS NOT NULL AND NOT EXISTS (SELECT 1 FROM area_risk_data ard WHERE ard.suburb ILIKE p.suburb AND ard.city ILIKE p.city AND ard.risk_type = 'fibre_coverage')
  `).catch(() => []);

  // Top-line for last night
  const totals = {
    runs: lastNightRuns.length,
    collected: lastNight.reduce((s, x) => s + x.collected, 0),
    errors: lastNight.reduce((s, x) => s + x.errors, 0),
    failed_scrapers: lastNight.filter((x) => x.status === "failed" || x.status === "timeout").length,
    empty_scrapers: lastNight.filter((x) => x.status === "empty").length,
  };

  let suggestions: string | null = null;
  if (wantSuggestions) {
    try {
      const Anthropic = (await import("@anthropic-ai/sdk")).default;
      const claude = new Anthropic();

      // Scrapers that already exist — so the model doesn't suggest ones we already have
      const existingScrapers = [
        "PrivateProperty + Property24 listings", "Crime (SAPS precinct stats)",
        "Solar (PVGIS)", "Water quality (DWS Blue/Green Drop)",
        "Municipal valuation roll (6 metros)", "SAPS stations + CPF",
        "Security coverage (Assist247, Procompare)", "Schools (Google Places 3km)",
        "Climate (Open-Meteo rainfall/wind/humidity)", "Load shedding (EskomSePush)",
        "Sold prices + price trends (Property24)", "True cost (transfer duty, bond, attorney)",
        "Fibre coverage (Openserve, Vumatel, Frogfoot)", "Electricity tariffs",
        "Deeds (GVR free + DeedsWeb per-query)",
        "Articles (SA construction/defect knowledge)",
        "Stock footage (Pexels, Mixkit, Unsplash)", "TikTok trending hashtags",
      ].join("; ");

      const noData = lastNight.length === 0 && gaps.length > 0;

      const prompt = `You write a morning brief for the SurePath scraper operator. SurePath is a SA property due-diligence service.

OUTPUT RULES (strict):
- Plain text. No markdown headings, no tables, no horizontal rules, no emojis, no bold.
- 5 bullets maximum, each one line, each starts with "- ".
- No filler, no restating the question, no greetings, no closing line.
- If there is nothing to say in a section, skip it — do not pad.
- Total length: 80 words max.
- When you mention a scraper, use its exact name.
- Do NOT suggest data sources we already have (listed below).

WHAT TO COVER (only if there's real signal):
1. One-line health verdict.
2. Broken scrapers + likely cause, inferred from error_sample (only if fail_rate or errors > 0).
3. Biggest coverage backlog and the one scraper to run today to close it.
4. One new SA data source worth adding (only if genuinely novel — not on the existing list).

EXISTING SCRAPERS (do not propose these): ${existingScrapers}

DATA:
last_night_totals=${JSON.stringify(totals)}
per_scraper=${JSON.stringify(lastNight)}
scheduled_missing=${JSON.stringify(gaps)}
underperformers_7d=${JSON.stringify(underperformers)}
backlog=${JSON.stringify(backlog)}

${noData ? "NOTE: no runs recorded in last 24h — likely the tracker wasn't running during the last cron. Skip the health verdict; lead with the single action that will produce real data (e.g. trigger a manual run), then note the biggest backlog." : ""}`;

      const resp = await claude.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 400,
        messages: [{ role: "user", content: prompt }],
      });
      const block = resp.content.find((b) => b.type === "text");
      suggestions = block && block.type === "text" ? block.text.trim() : null;
    } catch (e) {
      suggestions = `AI brief unavailable: ${(e as Error).message}`;
    }
  }

  return NextResponse.json({
    window_start: since.toISOString(),
    window_end: now.toISOString(),
    totals,
    runs: lastNightRuns,
    last_night: lastNight,
    gaps,
    underperformers,
    backlog,
    suggestions,
  });
});
