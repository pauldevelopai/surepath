/**
 * Smart daily scraper orchestrator.
 * Runs every night and executes the right scrapers based on day of week / month.
 *
 * Tiers:
 *   DAILY (every run)         : articles, crime, loadshedding
 *   WEEKLY (Sunday)           : pexels, mixkit, unsplash, soldprices, pricetrends
 *   MONTHLY (1st of month)    : schools, climate, fibre, electricity, solar
 *
 * Heavy one-off scrapers (gvr, saps, assist247, procompare, water, propertycosts)
 * are triggered manually from /admin/data/scraper when needed.
 *
 * Each scraper runs sequentially with a timeout. FFmpeg-heavy stock scrapers
 * run with nice priority to keep the dashboard responsive.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const { spawn } = require('child_process');
const path = require('path');
const tracker = require(path.resolve(__dirname, '..', 'scraper-run-tracker'));

const ROOT = path.resolve(__dirname, '..');
const BOOTSTRAP = __dirname;

let CURRENT_RUN_ID = null;

function runCmd({ name, cmd, args, cwd = ROOT, nice = false, timeoutMin = 90 }) {
  return new Promise(async (resolve) => {
    const start = Date.now();
    console.log(`\n[orchestrator] START ${name}`);

    const itemId = await tracker.startItem(CURRENT_RUN_ID, name);
    let collected = 0;
    let errorSample = null;
    let timedOut = false;

    const actualCmd = nice ? 'nice' : cmd;
    const actualArgs = nice ? ['-n', '15', cmd, ...args] : args;

    const child = spawn(actualCmd, actualArgs, { cwd, env: process.env, stdio: 'pipe' });

    child.stdout.on('data', (c) => {
      const text = c.toString();
      // Heuristic: count "OK" / "NEW" / "stored" / "success" lines as collected items
      for (const line of text.split('\n')) {
        if (/\b(OK|NEW|stored|success)\b/i.test(line)) collected++;
      }
      const lines = text.trim().split('\n');
      const last = lines[lines.length - 1];
      if (last) console.log(`  [${name}] ${last.slice(0, 200)}`);
    });
    child.stderr.on('data', (c) => {
      const text = c.toString().trim();
      if (text && !errorSample) errorSample = text.slice(0, 500);
      console.error(`  [${name}:err] ${text.slice(0, 200)}`);
    });

    const killTimer = setTimeout(() => {
      console.error(`[${name}] TIMEOUT (${timeoutMin} min) — killing`);
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMin * 60 * 1000);

    child.on('exit', async (code) => {
      clearTimeout(killTimer);
      const secs = Math.round((Date.now() - start) / 1000);
      console.log(`[orchestrator] ${name} exited code=${code} duration=${secs}s`);
      const status = timedOut ? 'timeout'
                   : code === 0 ? (collected > 0 ? 'success' : 'empty')
                   : 'failed';
      await tracker.endItem(itemId, {
        collected,
        errors: code === 0 ? 0 : 1,
        status,
        errorSample: status === 'failed' || status === 'timeout' ? (errorSample || `exit ${code}`) : null,
      });
      resolve(code);
    });
  });
}

// Inline -e script for scrapers that aren't standalone files.
// These mirror the logic in dashboard/app/api/scraper/route.ts.
function inlineCmd(name, code, opts = {}) {
  return { name, cmd: 'node', args: ['-e', code], ...opts };
}

const DAILY = [
  // Articles — news/articles scrape + RAG re-seed
  inlineCmd('articles', `
    require('dotenv').config();
    const pool = require('./db');
    const { collectKnowledge } = require('./collect-knowledge');
    (async () => {
      try {
        const r = await collectKnowledge();
        console.log('Articles:', r.created, 'new,', r.skipped, 'dup,', r.errors, 'err');
        const { seedRAG } = require('./seed-rag');
        await seedRAG();
      } catch (e) { console.error('Articles failed:', e.message); }
      await pool.end();
      process.exit(0);
    })();
  `, { timeoutMin: 30 }),

  // Crime — process up to 30 suburbs per run
  inlineCmd('crime', `
    require('dotenv').config();
    const pool = require('./db');
    const { collectForProperty } = require('./collect-crime');
    (async () => {
      const { rows } = await pool.query("SELECT DISTINCT ON (p.suburb, p.city) p.id, p.suburb, p.city FROM properties p WHERE p.suburb IS NOT NULL AND p.city IS NOT NULL AND NOT EXISTS (SELECT 1 FROM area_risk_data ard WHERE ard.suburb ILIKE p.suburb AND ard.city ILIKE p.city AND ard.risk_type = 'crime_detailed') ORDER BY p.suburb, p.city, p.created_at DESC LIMIT 30");
      console.log('Crime:', rows.length, 'suburbs');
      for (const prop of rows) { try { await collectForProperty(prop.id); } catch (e) { console.log('SKIP', prop.suburb, e.message); } }
      await pool.end(); process.exit(0);
    })();
  `, { timeoutMin: 30 }),

  // Load shedding — process up to 20 suburbs
  inlineCmd('loadshedding', `
    require('dotenv').config();
    const pool = require('./db');
    const { collectForProperty } = require('./collect-loadshedding');
    (async () => {
      const { rows } = await pool.query("SELECT DISTINCT ON (p.suburb, p.city) p.id, p.suburb, p.city FROM properties p WHERE p.lat IS NOT NULL AND p.suburb IS NOT NULL AND NOT EXISTS (SELECT 1 FROM area_risk_data ard WHERE ard.suburb ILIKE p.suburb AND ard.city ILIKE p.city AND ard.risk_type = 'loadshedding') ORDER BY p.suburb, p.city, p.created_at DESC LIMIT 20");
      console.log('Loadshedding:', rows.length, 'suburbs');
      for (const prop of rows) { try { await collectForProperty(prop.id); } catch (e) { console.log('ERR', prop.suburb, e.message); } await new Promise(r => setTimeout(r, 2000)); }
      await pool.end(); process.exit(0);
    })();
  `, { timeoutMin: 30 }),
];

const WEEKLY_SUNDAY = [
  { name: 'pexels', cmd: 'node', args: [path.join(BOOTSTRAP, 'scrape-pexels.js')], nice: true, timeoutMin: 30 },
  { name: 'mixkit', cmd: 'node', args: [path.join(BOOTSTRAP, 'scrape-mixkit.js')], nice: true, timeoutMin: 60 },
  { name: 'unsplash', cmd: 'node', args: [path.join(BOOTSTRAP, 'scrape-unsplash-photos.js')], nice: true, timeoutMin: 30 },

  inlineCmd('soldprices', `
    require('dotenv').config();
    const pool = require('./db');
    const { collectForProperty } = require('./collect-sold-prices');
    (async () => {
      const { rows } = await pool.query("SELECT DISTINCT ON (p.suburb, p.city) p.id FROM properties p WHERE p.suburb IS NOT NULL AND p.city IS NOT NULL AND NOT EXISTS (SELECT 1 FROM area_risk_data ard WHERE ard.suburb ILIKE p.suburb AND ard.city ILIKE p.city AND ard.risk_type = 'sold_prices') ORDER BY p.suburb, p.city, p.created_at DESC LIMIT 25");
      console.log('SoldPrices:', rows.length, 'suburbs');
      for (const prop of rows) { try { await collectForProperty(prop.id); } catch (e) {} await new Promise(r => setTimeout(r, 1000)); }
      await pool.end(); process.exit(0);
    })();
  `, { timeoutMin: 45 }),

  inlineCmd('pricetrends', `
    require('dotenv').config();
    const pool = require('./db');
    const { collectForProperty } = require('./collect-price-trends');
    (async () => {
      const { rows } = await pool.query("SELECT DISTINCT ON (p.suburb, p.city) p.id FROM properties p WHERE p.suburb IS NOT NULL AND p.city IS NOT NULL AND NOT EXISTS (SELECT 1 FROM area_risk_data ard WHERE ard.suburb ILIKE p.suburb AND ard.city ILIKE p.city AND ard.risk_type = 'price_trends') ORDER BY p.suburb, p.city, p.created_at DESC LIMIT 25");
      console.log('PriceTrends:', rows.length, 'suburbs');
      for (const prop of rows) { try { await collectForProperty(prop.id); } catch (e) {} await new Promise(r => setTimeout(r, 1000)); }
      await pool.end(); process.exit(0);
    })();
  `, { timeoutMin: 45 }),
];

const MONTHLY_FIRST = [
  inlineCmd('schools', `
    require('dotenv').config();
    const pool = require('./db');
    const { collectForProperty } = require('./collect-schools');
    (async () => {
      const { rows } = await pool.query("SELECT DISTINCT ON (p.suburb, p.city) p.id FROM properties p WHERE p.lat IS NOT NULL AND p.suburb IS NOT NULL AND NOT EXISTS (SELECT 1 FROM area_risk_data ard WHERE ard.suburb ILIKE p.suburb AND ard.city ILIKE p.city AND ard.risk_type = 'school_proximity') ORDER BY p.suburb, p.city, p.created_at DESC LIMIT 30");
      console.log('Schools:', rows.length, 'suburbs');
      for (const prop of rows) { try { await collectForProperty(prop.id); } catch (e) {} await new Promise(r => setTimeout(r, 1000)); }
      await pool.end(); process.exit(0);
    })();
  `, { timeoutMin: 60 }),

  inlineCmd('climate', `
    require('dotenv').config();
    const pool = require('./db');
    const { collectForProperty } = require('./collect-climate');
    (async () => {
      const { rows } = await pool.query("SELECT DISTINCT ON (p.suburb, p.city) p.id FROM properties p WHERE p.lat IS NOT NULL AND p.suburb IS NOT NULL AND NOT EXISTS (SELECT 1 FROM area_risk_data ard WHERE ard.suburb ILIKE p.suburb AND ard.city ILIKE p.city AND ard.risk_type = 'climate') ORDER BY p.suburb, p.city, p.created_at DESC LIMIT 30");
      console.log('Climate:', rows.length, 'suburbs');
      for (const prop of rows) { try { await collectForProperty(prop.id); } catch (e) {} await new Promise(r => setTimeout(r, 500)); }
      await pool.end(); process.exit(0);
    })();
  `, { timeoutMin: 45 }),

  inlineCmd('fibre', `
    require('dotenv').config();
    const pool = require('./db');
    const { collectForProperty } = require('./collect-fibre');
    (async () => {
      const { rows } = await pool.query("SELECT DISTINCT ON (p.suburb, p.city) p.id FROM properties p WHERE p.suburb IS NOT NULL AND NOT EXISTS (SELECT 1 FROM area_risk_data ard WHERE ard.suburb ILIKE p.suburb AND ard.city ILIKE p.city AND ard.risk_type = 'fibre_coverage') ORDER BY p.suburb, p.city, p.created_at DESC LIMIT 30");
      console.log('Fibre:', rows.length, 'suburbs');
      for (const prop of rows) { try { await collectForProperty(prop.id); } catch (e) {} await new Promise(r => setTimeout(r, 1000)); }
      await pool.end(); process.exit(0);
    })();
  `, { timeoutMin: 60 }),

  inlineCmd('electricity', `
    require('dotenv').config();
    const pool = require('./db');
    const { collectForProperty } = require('./collect-electricity');
    (async () => {
      const { rows } = await pool.query("SELECT DISTINCT ON (p.suburb, p.city) p.id FROM properties p WHERE p.suburb IS NOT NULL AND NOT EXISTS (SELECT 1 FROM area_risk_data ard WHERE ard.suburb ILIKE p.suburb AND ard.city ILIKE p.city AND ard.risk_type = 'electricity') ORDER BY p.suburb, p.city, p.created_at DESC LIMIT 30");
      console.log('Electricity:', rows.length, 'suburbs');
      for (const prop of rows) { try { await collectForProperty(prop.id); } catch (e) {} await new Promise(r => setTimeout(r, 500)); }
      await pool.end(); process.exit(0);
    })();
  `, { timeoutMin: 45 }),

  inlineCmd('solar', `
    require('dotenv').config();
    const pool = require('./db');
    const mod = require('./collect-solar');
    const fn = mod.collectForProperty || mod.getSolarData;
    (async () => {
      const { rows } = await pool.query("SELECT id, suburb FROM properties WHERE lat IS NOT NULL AND lng IS NOT NULL AND solar_ghi_kwh_year IS NULL ORDER BY created_at DESC LIMIT 50");
      console.log('Solar:', rows.length, 'properties');
      for (const prop of rows) { try { await fn(prop.id); } catch (e) {} }
      await pool.end(); process.exit(0);
    })();
  `, { timeoutMin: 45 }),
];

async function run() {
  const now = new Date();
  const dayOfWeek = now.getUTCDay();      // 0 = Sunday
  const dayOfMonth = now.getUTCDate();

  console.log(`\n[orchestrator] ${now.toISOString()}  dow=${dayOfWeek} dom=${dayOfMonth}`);

  const jobs = [...DAILY];
  if (dayOfWeek === 0) jobs.push(...WEEKLY_SUNDAY);
  // Spread monthly jobs across the first 5 days to avoid overload
  if (dayOfMonth >= 1 && dayOfMonth <= MONTHLY_FIRST.length) {
    jobs.push(MONTHLY_FIRST[dayOfMonth - 1]);
  }

  console.log(`[orchestrator] Queued ${jobs.length}: ${jobs.map((j) => j.name).join(', ')}`);

  CURRENT_RUN_ID = await tracker.startRun({
    runType: 'scheduled',
    trigger: 'cron',
    notes: `dow=${dayOfWeek} dom=${dayOfMonth} jobs=${jobs.map((j) => j.name).join(',')}`,
  });

  let totalErrors = 0;
  for (const job of jobs) {
    try {
      const code = await runCmd(job);
      if (code !== 0) totalErrors++;
    } catch (e) {
      console.error(`[orchestrator] ${job.name} crashed: ${e.message}`);
      totalErrors++;
    }
  }

  await tracker.endRun(CURRENT_RUN_ID, {
    status: totalErrors === 0 ? 'success' : (totalErrors === jobs.length ? 'failed' : 'partial'),
    totalCollected: 0, // per-item collected is recorded per scraper_run_items row
    totalErrors,
  });

  console.log('\n[orchestrator] ALL DONE');
  process.exit(0);
}

run().catch((e) => { console.error('[orchestrator] FATAL:', e); process.exit(1); });
