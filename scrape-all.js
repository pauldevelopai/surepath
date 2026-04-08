#!/usr/bin/env node
/**
 * SUREPATH MASTER SCRAPER
 *
 * Runs ALL scrapers in sequence, processing everything that's pending.
 * Designed to run for hours unattended as a background process.
 *
 * Usage:
 *   node scrape-all.js              # Run all scrapers
 *   node scrape-all.js --once       # Single pass only (no looping)
 *   node scrape-all.js --stop       # Write stop signal
 *
 * The process writes status to /tmp/surepath-scraper-status.json
 * so the dashboard can read progress even after page refresh.
 */
require('dotenv').config();
const pool = require('./db');
const fs = require('fs');
const path = require('path');

const STATUS_FILE = '/tmp/surepath-scraper-status.json';
const STOP_FILE = '/tmp/surepath-scraper-stop';
const BATCH_SIZE = 5; // small batches — rotate through all scrapers quickly
const DELAY_BETWEEN_ITEMS = 1500; // ms between individual API calls
const DELAY_BETWEEN_SCRAPERS = 3000; // ms between scraper types
const LOOP_DELAY = 5000; // ms between full rotation passes

// ─── Status tracking ────────────────────────────────────────────────
let status = {
  running: false,
  started_at: null,
  current_scraper: null,
  pass: 0,
  total_collected: 0,
  scrapers: {},
  last_update: null,
  stopped_reason: null,
};

function updateStatus(updates) {
  Object.assign(status, updates, { last_update: new Date().toISOString() });
  try { fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2)); } catch {}
}

function shouldStop() {
  return fs.existsSync(STOP_FILE);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function withTimeout(fn, ms, label) {
  return Promise.race([
    fn(),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms)),
  ]);
}

function log(msg) {
  const ts = new Date().toISOString().substring(11, 19);
  console.log(`[${ts}] ${msg}`);
}

// ─── Individual scraper runners ─────────────────────────────────────
// Each returns { processed, skipped, errors }

async function runCrime() {
  const { rows } = await pool.query(`
    SELECT DISTINCT ON (p.suburb, p.city) p.id, p.suburb, p.city
    FROM properties p
    WHERE p.suburb IS NOT NULL AND p.city IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM area_risk_data ard WHERE ard.suburb ILIKE p.suburb AND ard.city ILIKE p.city AND ard.risk_type = 'crime_detailed')
    ORDER BY p.suburb, p.city, p.created_at DESC LIMIT ${BATCH_SIZE}
  `);
  if (rows.length === 0) return { processed: 0, skipped: 0, errors: 0, done: true };

  const { collectForProperty } = require('./collect-crime');
  let processed = 0, errors = 0;
  for (const prop of rows) {
    if (shouldStop()) break;
    try {
      const r = await collectForProperty(prop.id);
      if (r?.station) { log(`Crime OK: ${prop.suburb}, ${prop.city}`); processed++; }
      else { log(`Crime skip: ${prop.suburb} — ${r?.error || 'no data'}`); }
    } catch (e) { log(`Crime error: ${prop.suburb} — ${e.message}`); errors++; }
    await sleep(DELAY_BETWEEN_ITEMS);
  }
  return { processed, skipped: rows.length - processed - errors, errors, done: false };
}

async function runClimate() {
  const { rows } = await pool.query(`
    SELECT DISTINCT ON (p.suburb, p.city) p.id, p.suburb, p.city
    FROM properties p
    WHERE p.lat IS NOT NULL AND p.suburb IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM area_risk_data ard WHERE ard.suburb ILIKE p.suburb AND ard.city ILIKE p.city AND ard.risk_type = 'climate')
    ORDER BY p.suburb, p.city, p.created_at DESC LIMIT ${BATCH_SIZE}
  `);
  if (rows.length === 0) return { processed: 0, done: true };

  const { collectForProperty } = require('./collect-climate');
  let processed = 0, errors = 0;
  for (const prop of rows) {
    if (shouldStop()) break;
    try { await collectForProperty(prop.id); log(`Climate OK: ${prop.suburb}`); processed++; }
    catch (e) { log(`Climate error: ${prop.suburb} — ${e.message}`); errors++; }
    await sleep(DELAY_BETWEEN_ITEMS);
  }
  return { processed, errors, done: false };
}

async function runSchools() {
  const { rows } = await pool.query(`
    SELECT DISTINCT ON (p.suburb, p.city) p.id, p.suburb, p.city
    FROM properties p
    WHERE p.lat IS NOT NULL AND p.suburb IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM area_risk_data ard WHERE ard.suburb ILIKE p.suburb AND ard.city ILIKE p.city AND ard.risk_type = 'school_proximity')
    ORDER BY p.suburb, p.city, p.created_at DESC LIMIT ${BATCH_SIZE}
  `);
  if (rows.length === 0) return { processed: 0, done: true };

  const { collectForProperty } = require('./collect-schools');
  let processed = 0, errors = 0;
  for (const prop of rows) {
    if (shouldStop()) break;
    try { await collectForProperty(prop.id); log(`Schools OK: ${prop.suburb}`); processed++; }
    catch (e) { log(`Schools error: ${prop.suburb} — ${e.message}`); errors++; }
    await sleep(DELAY_BETWEEN_ITEMS);
  }
  return { processed, errors, done: false };
}

async function runWater() {
  const { rows } = await pool.query(`
    SELECT DISTINCT ON (p.city) p.id, p.city
    FROM properties p
    WHERE p.city IS NOT NULL AND p.water_quality_score IS NULL
    ORDER BY p.city, p.created_at DESC LIMIT ${BATCH_SIZE}
  `);
  if (rows.length === 0) return { processed: 0, done: true };

  const { collectForProperty } = require('./collect-municipal');
  let processed = 0, errors = 0;
  for (const prop of rows) {
    if (shouldStop()) break;
    try {
      const r = await collectForProperty(prop.id);
      if (r?.water_quality_score != null) { log(`Water OK: ${prop.city} — ${r.water_quality_score}/10`); processed++; }
      else { log(`Water skip: ${prop.city} — not in DWS dataset`); }
    } catch (e) { log(`Water error: ${prop.city} — ${e.message}`); errors++; }
    await sleep(DELAY_BETWEEN_ITEMS);
  }
  return { processed, errors, done: false };
}

async function runSolar() {
  const { rows } = await pool.query(`
    SELECT id, suburb FROM properties
    WHERE lat IS NOT NULL AND lng IS NOT NULL AND solar_ghi_kwh_year IS NULL
    ORDER BY created_at DESC LIMIT ${BATCH_SIZE}
  `);
  if (rows.length === 0) return { processed: 0, done: true };

  const mod = require('./collect-solar');
  const fn = mod.collectForProperty || mod.getSolarData;
  let processed = 0, errors = 0;
  for (const prop of rows) {
    if (shouldStop()) break;
    try {
      const r = await fn(prop.id);
      if (r?.ghi_kwh_m2_year || r?.ghi) { log(`Solar OK: ${prop.suburb || prop.id}`); processed++; }
    } catch (e) { log(`Solar error: ${prop.suburb || prop.id} — ${e.message}`); errors++; }
    await sleep(DELAY_BETWEEN_ITEMS);
  }
  return { processed, errors, done: false };
}

async function runSecurity() {
  const { rows } = await pool.query(`
    SELECT DISTINCT ON (p.suburb, p.city) p.id, p.suburb, p.city
    FROM properties p
    WHERE p.lat IS NOT NULL AND p.suburb IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM area_risk_data ard WHERE ard.suburb ILIKE p.suburb AND ard.city ILIKE p.city AND ard.risk_type = 'security_community')
    ORDER BY p.suburb, p.city, p.created_at DESC LIMIT ${BATCH_SIZE}
  `);
  if (rows.length === 0) return { processed: 0, done: true };

  const { collectForProperty } = require('./collect-security');
  let processed = 0, errors = 0;
  for (const prop of rows) {
    if (shouldStop()) break;
    try { await collectForProperty(prop.id); log(`Security OK: ${prop.suburb}`); processed++; }
    catch (e) { log(`Security error: ${prop.suburb} — ${e.message}`); errors++; }
    await sleep(DELAY_BETWEEN_ITEMS);
  }
  return { processed, errors, done: false };
}

async function runSocial() {
  const { rows } = await pool.query(`
    SELECT DISTINCT ON (p.suburb, p.city) p.id, p.suburb, p.city
    FROM properties p
    WHERE p.lat IS NOT NULL AND p.suburb IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM area_risk_data ard WHERE ard.suburb ILIKE p.suburb AND ard.city ILIKE p.city AND ard.risk_type = 'social_concerns')
    ORDER BY p.suburb, p.city, p.created_at DESC LIMIT ${BATCH_SIZE}
  `);
  if (rows.length === 0) return { processed: 0, done: true };

  const { collectForProperty } = require('./collect-social');
  let processed = 0, errors = 0;
  for (const prop of rows) {
    if (shouldStop()) break;
    try { await collectForProperty(prop.id); log(`Social OK: ${prop.suburb}`); processed++; }
    catch (e) { log(`Social error: ${prop.suburb} — ${e.message}`); errors++; }
    await sleep(2000); // Google Places needs slower rate
  }
  return { processed, errors, done: false };
}

async function runElectricity() {
  const { rows } = await pool.query(`
    SELECT DISTINCT ON (p.city) p.id, p.city
    FROM properties p
    WHERE p.city IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM area_risk_data ard WHERE ard.city ILIKE p.city AND ard.risk_type = 'electricity')
    ORDER BY p.city, p.created_at DESC LIMIT ${BATCH_SIZE}
  `);
  if (rows.length === 0) return { processed: 0, done: true };

  const { collectForProperty } = require('./collect-electricity');
  let processed = 0, errors = 0;
  for (const prop of rows) {
    if (shouldStop()) break;
    try { await collectForProperty(prop.id); log(`Electricity OK: ${prop.city}`); processed++; }
    catch (e) { log(`Electricity error: ${prop.city} — ${e.message}`); errors++; }
    await sleep(500);
  }
  return { processed, errors, done: false };
}

async function runFibre() {
  const { rows } = await pool.query(`
    SELECT DISTINCT ON (p.suburb, p.city) p.id, p.suburb, p.city
    FROM properties p
    WHERE p.suburb IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM area_risk_data ard WHERE ard.suburb ILIKE p.suburb AND ard.city ILIKE p.city AND ard.risk_type = 'fibre_coverage')
    ORDER BY p.suburb, p.city, p.created_at DESC LIMIT ${BATCH_SIZE}
  `);
  if (rows.length === 0) return { processed: 0, done: true };

  const { collectForProperty } = require('./collect-fibre');
  let processed = 0, errors = 0;
  for (const prop of rows) {
    if (shouldStop()) break;
    try { await collectForProperty(prop.id); log(`Fibre OK: ${prop.suburb}`); processed++; }
    catch (e) { log(`Fibre error: ${prop.suburb} — ${e.message}`); errors++; }
    await sleep(500);
  }
  return { processed, errors, done: false };
}

async function runSoldPrices() {
  const { rows } = await pool.query(`
    SELECT DISTINCT ON (p.suburb, p.city) p.id, p.suburb, p.city
    FROM properties p
    WHERE p.suburb IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM area_risk_data ard WHERE ard.suburb ILIKE p.suburb AND ard.city ILIKE p.city AND ard.risk_type = 'sold_prices')
    ORDER BY p.suburb, p.city, p.created_at DESC LIMIT ${BATCH_SIZE}
  `);
  if (rows.length === 0) return { processed: 0, done: true };

  const { collectForProperty } = require('./collect-sold-prices');
  let processed = 0, errors = 0;
  for (const prop of rows) {
    if (shouldStop()) break;
    try { await collectForProperty(prop.id); log(`Sold prices OK: ${prop.suburb}`); processed++; }
    catch (e) { log(`Sold prices error: ${prop.suburb} — ${e.message}`); errors++; }
    await sleep(3000); // P24 needs slow rate
  }
  return { processed, errors, done: false };
}

async function runPriceTrends() {
  const { rows } = await pool.query(`
    SELECT DISTINCT ON (p.suburb, p.city) p.id, p.suburb, p.city
    FROM properties p
    WHERE p.suburb IS NOT NULL AND p.city IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM area_risk_data ard WHERE ard.suburb ILIKE p.suburb AND ard.city ILIKE p.city AND ard.risk_type = 'price_trends')
    ORDER BY p.suburb, p.city, p.created_at DESC LIMIT ${BATCH_SIZE}
  `);
  if (rows.length === 0) return { processed: 0, done: true };

  const { collectForProperty } = require('./collect-price-trends');
  let processed = 0, errors = 0;
  for (const prop of rows) {
    if (shouldStop()) break;
    try { await collectForProperty(prop.id); log(`Price trends OK: ${prop.suburb}`); processed++; }
    catch (e) { log(`Price trends error: ${prop.suburb} — ${e.message}`); errors++; }
    await sleep(3000);
  }
  return { processed, errors, done: false };
}

async function runPropertyCosts() {
  const { rows } = await pool.query(`
    SELECT id, suburb FROM properties
    WHERE asking_price > 0 AND suburb IS NOT NULL
      AND (extra_costs_json IS NULL)
    ORDER BY created_at DESC LIMIT ${BATCH_SIZE * 3}
  `);
  if (rows.length === 0) return { processed: 0, done: true };

  const { collectForProperty } = require('./collect-property-costs');
  let processed = 0, errors = 0;
  for (const prop of rows) {
    if (shouldStop()) break;
    try { await collectForProperty(prop.id); processed++; }
    catch (e) { log(`Property costs error: ${prop.suburb} — ${e.message}`); errors++; }
  }
  return { processed, errors, done: false };
}

async function runLoadshedding() {
  const { rows } = await pool.query(`
    SELECT DISTINCT ON (p.suburb, p.city) p.id, p.suburb, p.city
    FROM properties p
    WHERE p.lat IS NOT NULL AND p.suburb IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM area_risk_data ard WHERE ard.suburb ILIKE p.suburb AND ard.city ILIKE p.city AND ard.risk_type = 'loadshedding')
    ORDER BY p.suburb, p.city, p.created_at DESC LIMIT ${BATCH_SIZE}
  `);
  if (rows.length === 0) return { processed: 0, done: true };

  const { collectForProperty } = require('./collect-loadshedding');
  let processed = 0, errors = 0;
  for (const prop of rows) {
    if (shouldStop()) break;
    try { await collectForProperty(prop.id); log(`Loadshedding OK: ${prop.suburb}`); processed++; }
    catch (e) { log(`Loadshedding error: ${prop.suburb} — ${e.message}`); errors++; }
    await sleep(2000);
  }
  return { processed, errors, done: false };
}

async function runGVR() {
  try {
    const { collectAllGVRs } = require('./collect-gvr');
    log('[gvr] Starting municipal valuation roll collection...');
    const result = await collectAllGVRs();
    const processed = result?.total || result?.updated || 0;
    log(`[gvr] Done: ${JSON.stringify(result)}`);
    return { processed, errors: 0, done: processed === 0 };
  } catch (e) {
    log(`GVR error: ${e.message}`);
    return { processed: 0, errors: 1, done: false };
  }
}

async function runArticles() {
  try {
    const { collectKnowledge } = require('./collect-knowledge');
    log('[articles] Starting article collection...');
    const result = await collectKnowledge();
    log(`[articles] Done: ${result.created} created, ${result.skipped} skipped, ${result.errors} errors`);
    return { processed: result.created || 0, errors: result.errors || 0, done: result.created === 0 };
  } catch (e) {
    log(`Articles error: ${e.message}`);
    return { processed: 0, errors: 1, done: false };
  }
}

// Standalone scraper runner — spawns a bootstrap script as a child process
function runScript(scriptPath, label, timeoutMs = 120000) {
  return async function() {
    const cp = require('child_process');
    return new Promise((resolve) => {
      let processed = 0;
      const proc = cp.spawn('node', [scriptPath], {
        cwd: __dirname,
        env: { ...process.env, FORCE_COLOR: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const timeout = setTimeout(() => {
        try { proc.kill('SIGTERM'); } catch {}
        log(`[${label}] Killed — exceeded ${Math.round(timeoutMs / 1000)}s timeout`);
        resolve({ processed, errors: 1, done: false });
      }, timeoutMs);

      proc.stdout.on('data', (d) => {
        const lines = d.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          log(`[${label}] ${line}`);
          if (line.includes('OK') || line.includes('NEW') || line.includes('success') || line.includes('stored')) processed++;
        }
      });
      proc.stderr.on('data', (d) => {
        d.toString().split('\n').filter(Boolean).forEach(l => log(`[${label}] [ERROR] ${l}`));
      });
      proc.on('close', (code) => {
        clearTimeout(timeout);
        resolve({ processed, errors: code !== 0 ? 1 : 0, done: true });
      });
    });
  };
}

// ─── Scraper registry ───────────────────────────────────────────────
// All 15+ scrapers get a turn in rotation
const SCRAPERS = [
  // Per-property/suburb collectors (fast, batch-based)
  { name: 'electricity', fn: runElectricity, label: 'Electricity tariffs' },
  { name: 'fibre', fn: runFibre, label: 'Fibre coverage' },
  { name: 'water', fn: runWater, label: 'Water quality' },
  { name: 'crime', fn: runCrime, label: 'Crime data' },
  { name: 'climate', fn: runClimate, label: 'Climate data' },
  { name: 'schools', fn: runSchools, label: 'Schools nearby' },
  { name: 'solar', fn: runSolar, label: 'Solar data' },
  { name: 'security', fn: runSecurity, label: 'Security coverage' },
  { name: 'social', fn: runSocial, label: 'Social concerns' },
  { name: 'sold_prices', fn: runSoldPrices, label: 'Sold prices' },
  { name: 'loadshedding', fn: runLoadshedding, label: 'Load shedding' },
  { name: 'price_trends', fn: runPriceTrends, label: 'Price trends' },
  { name: 'property_costs', fn: runPropertyCosts, label: 'Property costs' },
  { name: 'gvr', fn: runGVR, label: 'Municipal GVR' },
  { name: 'articles', fn: runArticles, label: 'Knowledge articles' },
  // Standalone web scrapers (spawn as child process with timeout)
  { name: 'pp', fn: runScript(path.join(__dirname, 'bootstrap', 'scrape-pp.js'), 'pp', 300000), label: 'PrivateProperty' },
  { name: 'saps', fn: runScript(path.join(__dirname, 'bootstrap', 'scrape-saps-stations.js'), 'saps', 180000), label: 'SAPS stations' },
  { name: 'assist247', fn: runScript(path.join(__dirname, 'bootstrap', 'scrape-assist247.js'), 'assist247', 180000), label: 'Assist247' },
  { name: 'procompare', fn: runScript(path.join(__dirname, 'bootstrap', 'scrape-procompare.js'), 'procompare', 180000), label: 'Procompare' },
];

// ─── Main loop ──────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const onceOnly = args.includes('--once');

  if (args.includes('--stop')) {
    fs.writeFileSync(STOP_FILE, new Date().toISOString());
    console.log('Stop signal written. Scraper will stop after current item.');
    process.exit(0);
  }

  // Remove any stale stop signal
  try { fs.unlinkSync(STOP_FILE); } catch {}

  updateStatus({ running: true, started_at: new Date().toISOString(), stopped_reason: null });
  log('=== SUREPATH MASTER SCRAPER STARTED ===');
  log(`${SCRAPERS.length} scrapers, batch size ${BATCH_SIZE}, ${onceOnly ? 'single pass' : 'continuous'}`);

  let pass = 0;

  while (true) {
    pass++;
    log(`\n--- Pass ${pass} ---`);
    updateStatus({ pass });

    let allDone = true;

    for (const scraper of SCRAPERS) {
      if (shouldStop()) break;

      updateStatus({ current_scraper: scraper.label });
      log(`[${scraper.name}] Starting...`);

      try {
        const result = await withTimeout(() => scraper.fn(), 120000, scraper.name);
        const scraperStatus = status.scrapers[scraper.name] || { total_processed: 0, total_errors: 0, runs: 0 };
        scraperStatus.total_processed += result.processed || 0;
        scraperStatus.total_errors += result.errors || 0;
        scraperStatus.runs++;
        scraperStatus.last_run = new Date().toISOString();
        scraperStatus.done = result.done;
        status.scrapers[scraper.name] = scraperStatus;
        status.total_collected += result.processed || 0;
        updateStatus({});

        if (!result.done) allDone = false;
        log(`[${scraper.name}] Done: ${result.processed || 0} processed, ${result.errors || 0} errors${result.done ? ' (ALL COMPLETE)' : ''}`);
      } catch (e) {
        log(`[${scraper.name}] FATAL: ${e.message}`);
        // Don't let a timeout stop the whole loop — move to next scraper
      }

      await sleep(DELAY_BETWEEN_SCRAPERS);
    }

    if (shouldStop()) {
      log('Stop signal received. Shutting down.');
      updateStatus({ running: false, current_scraper: null, stopped_reason: 'user_stopped' });
      break;
    }

    if (allDone) {
      log('\n=== ALL SCRAPERS COMPLETE — no more pending data ===');
      updateStatus({ running: false, current_scraper: null, stopped_reason: 'all_complete' });
      break;
    }

    if (onceOnly) {
      log('\n=== Single pass complete ===');
      updateStatus({ running: false, current_scraper: null, stopped_reason: 'single_pass' });
      break;
    }

    log(`\nWaiting ${LOOP_DELAY / 1000}s before next pass...`);
    updateStatus({ current_scraper: 'waiting' });
    await sleep(LOOP_DELAY);
  }

  // RAG re-seed happens via PM2 cron at 3am daily (rag-reseed process)
  // or manually via the "Re-seed RAG" button on the scraper page

  await pool.end();
  log('=== MASTER SCRAPER EXITED ===');
}

main().catch(e => {
  console.error('Fatal error:', e);
  updateStatus({ running: false, stopped_reason: 'error: ' + e.message });
  pool.end();
  process.exit(1);
});
