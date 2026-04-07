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

// ─── Scraper registry ───────────────────────────────────────────────
const SCRAPERS = [
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
        const result = await scraper.fn();
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

  await pool.end();
  log('=== MASTER SCRAPER EXITED ===');
}

main().catch(e => {
  console.error('Fatal error:', e);
  updateStatus({ running: false, stopped_reason: 'error: ' + e.message });
  pool.end();
  process.exit(1);
});
