/**
 * Persistent scraper run tracker. Used by scrape-all.js and run-scheduled-scrapers.js
 * to write run history into Postgres so the dashboard "Today" review has data.
 *
 * Tables are created lazily on first call (idempotent IF NOT EXISTS).
 */
const pool = require('./db');

let ensured = false;
async function ensureTables() {
  if (ensured) return;
  await pool.query(`
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
    );
    CREATE INDEX IF NOT EXISTS idx_scraper_runs_started ON scraper_runs(started_at DESC);
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
    );
    CREATE INDEX IF NOT EXISTS idx_scraper_run_items_run ON scraper_run_items(run_id);
    CREATE INDEX IF NOT EXISTS idx_scraper_run_items_name_started ON scraper_run_items(scraper_name, started_at DESC);
  `);
  ensured = true;
}

async function startRun({ runType, trigger, notes }) {
  try {
    await ensureTables();
    const { rows } = await pool.query(
      `INSERT INTO scraper_runs (run_type, trigger, notes) VALUES ($1, $2, $3) RETURNING id`,
      [runType, trigger || null, notes || null]
    );
    return rows[0].id;
  } catch (e) { console.error('[tracker] startRun failed:', e.message); return null; }
}

async function startItem(runId, scraperName) {
  if (!runId) return null;
  try {
    const { rows } = await pool.query(
      `INSERT INTO scraper_run_items (run_id, scraper_name) VALUES ($1, $2) RETURNING id, started_at`,
      [runId, scraperName]
    );
    return rows[0].id;
  } catch (e) { console.error('[tracker] startItem failed:', e.message); return null; }
}

async function endItem(itemId, { collected = 0, errors = 0, status = 'success', errorSample } = {}) {
  if (!itemId) return;
  try {
    await pool.query(
      `UPDATE scraper_run_items
       SET completed_at = NOW(),
           duration_seconds = EXTRACT(EPOCH FROM (NOW() - started_at))::int,
           collected = $2, errors = $3, status = $4, error_sample = $5
       WHERE id = $1`,
      [itemId, collected, errors, status, errorSample ? String(errorSample).slice(0, 500) : null]
    );
  } catch (e) { console.error('[tracker] endItem failed:', e.message); }
}

async function endRun(runId, { status = 'success', totalCollected = 0, totalErrors = 0 } = {}) {
  if (!runId) return;
  try {
    await pool.query(
      `UPDATE scraper_runs SET completed_at = NOW(), status = $2, total_collected = $3, total_errors = $4 WHERE id = $1`,
      [runId, status, totalCollected, totalErrors]
    );
  } catch (e) { console.error('[tracker] endRun failed:', e.message); }
}

module.exports = { ensureTables, startRun, startItem, endItem, endRun };
