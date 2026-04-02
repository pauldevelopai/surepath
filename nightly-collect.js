#!/usr/bin/env node
/**
 * Nightly Data Collection
 *
 * Runs overnight to collect free data for all properties.
 * Only uses free/no-cost APIs — no Google, no Anthropic.
 *
 * Data collected:
 * 1. CrimeHub crime data (free) — for all properties missing crime data
 * 2. PVGIS solar data (free) — for all properties missing solar data
 * 3. DWS water quality (free) — for all properties missing water quality
 * 4. PrivateProperty listings (free) — new listings in tracked suburbs
 *
 * Run: node nightly-collect.js
 * Schedule: crontab -e → 0 2 * * * cd /path/to/surepath && node nightly-collect.js >> logs/nightly.log 2>&1
 */

require('dotenv').config();
const pool = require('./db');

const BATCH_DELAY = 2000; // ms between requests to be polite

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function log(msg) {
  const ts = new Date().toISOString().substring(0, 19);
  console.log(`[${ts}] ${msg}`);
}

// ── 1. Crime Data from CrimeHub (FREE) ──
async function collectCrimeData() {
  const { collectForProperty } = require('./collect-crime');

  // Find properties without crime data
  const { rows } = await pool.query(`
    SELECT p.id, p.suburb, p.city
    FROM properties p
    WHERE p.suburb IS NOT NULL
      AND p.city IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM area_risk_data ard
        WHERE ard.suburb ILIKE p.suburb AND ard.city ILIKE p.city AND ard.risk_type = 'crime_detailed'
      )
    ORDER BY p.created_at DESC
  `);

  await log(`Crime: ${rows.length} properties missing crime data`);
  let success = 0, failed = 0;

  for (const prop of rows) {
    try {
      const result = await collectForProperty(prop.id);
      if (result && !result.error) {
        success++;
        await log(`  Crime OK: ${prop.suburb} → ${result.station} (${result.total} incidents)`);
      } else {
        failed++;
        await log(`  Crime SKIP: ${prop.suburb} — ${result?.error || 'no data'}`);
      }
    } catch (err) {
      failed++;
      await log(`  Crime ERROR: ${prop.suburb} — ${err.message}`);
    }
    await sleep(BATCH_DELAY);
  }

  await log(`Crime complete: ${success} OK, ${failed} failed`);
  return { success, failed };
}

// ── 2. Solar Data from PVGIS (FREE) ──
async function collectSolarData() {
  const { collectForProperty } = require('./collect-solar');

  // Find properties with coordinates but no solar data
  const { rows } = await pool.query(`
    SELECT id, suburb, lat, lng
    FROM properties
    WHERE lat IS NOT NULL AND lng IS NOT NULL
      AND solar_ghi_kwh_year IS NULL
    ORDER BY created_at DESC
  `);

  await log(`Solar: ${rows.length} properties missing solar data`);
  let success = 0, failed = 0;

  for (const prop of rows) {
    try {
      const result = await collectForProperty(prop.id);
      if (result && !result.error) {
        success++;
        await log(`  Solar OK: ${prop.suburb || prop.id} → ${result.ghi} kWh/m²/year`);
      } else {
        failed++;
        await log(`  Solar SKIP: ${prop.suburb || prop.id} — ${result?.error || 'no data'}`);
      }
    } catch (err) {
      failed++;
      await log(`  Solar ERROR: ${prop.suburb || prop.id} — ${err.message}`);
    }
    await sleep(BATCH_DELAY);
  }

  await log(`Solar complete: ${success} OK, ${failed} failed`);
  return { success, failed };
}

// ── 3. Water Quality from DWS (FREE) ──
async function collectWaterData() {
  let collectRiskData;
  try {
    collectRiskData = require('./bootstrap/collect-risk-data');
  } catch {
    await log('Water: collect-risk-data module not found, skipping');
    return { success: 0, failed: 0 };
  }

  // Find properties missing water quality data
  const { rows } = await pool.query(`
    SELECT id, suburb, city
    FROM properties
    WHERE city IS NOT NULL
      AND water_quality_score IS NULL
    ORDER BY created_at DESC
    LIMIT 50
  `);

  await log(`Water: ${rows.length} properties missing water data`);
  let success = 0, failed = 0;

  for (const prop of rows) {
    try {
      if (collectRiskData.collectWaterQuality) {
        await collectRiskData.collectWaterQuality(prop.id);
        success++;
        await log(`  Water OK: ${prop.suburb || prop.city}`);
      }
    } catch (err) {
      failed++;
      await log(`  Water ERROR: ${prop.suburb || prop.city} — ${err.message}`);
    }
    await sleep(BATCH_DELAY);
  }

  await log(`Water complete: ${success} OK, ${failed} failed`);
  return { success, failed };
}

// ── 4. Discover new PP listings in tracked suburbs (FREE) ──
async function discoverNewListings() {
  const { searchPP, fetchHTML } = require('./search-pp');

  // Get unique suburbs we're tracking
  const { rows: suburbs } = await pool.query(`
    SELECT DISTINCT suburb, city, province
    FROM properties
    WHERE suburb IS NOT NULL AND city IS NOT NULL
    ORDER BY suburb
    LIMIT 20
  `);

  await log(`PP Discovery: checking ${suburbs.length} suburbs for new listings`);
  let newFound = 0;

  for (const sub of suburbs) {
    try {
      const provinceSlug = (sub.province || 'gauteng').toLowerCase().replace(/\s+/g, '-');
      const citySlug = (sub.city || '').toLowerCase().replace(/\s+/g, '-');
      const suburbSlug = (sub.suburb || '').toLowerCase().replace(/\s+/g, '-');

      const result = await searchPP(provinceSlug, citySlug, suburbSlug, () => {});
      if (!result?.listings?.length) continue;

      // Check which listings we already have
      for (const listing of result.listings) {
        const existing = await pool.query('SELECT id FROM properties WHERE erf_number = $1', [`PP_${listing.ppId}`]);
        if (existing.rows.length === 0) {
          newFound++;
          await log(`  NEW: ${listing.ppId} in ${sub.suburb} — ${listing.url}`);
          // Store as a discovered listing (don't scrape yet — save API costs)
          await pool.query(`
            INSERT INTO properties (erf_number, address_raw, suburb, city, province, listing_url)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (erf_number) DO NOTHING`,
            [`PP_${listing.ppId}`, `Discovered in ${sub.suburb}`, sub.suburb, sub.city, sub.province, listing.url]
          );
        }
      }
    } catch (err) {
      await log(`  PP ERROR: ${sub.suburb} — ${err.message}`);
    }
    await sleep(BATCH_DELAY * 2); // Extra polite for PP
  }

  await log(`PP Discovery complete: ${newFound} new listings found`);
  return { newFound };
}

// ── 5. Update stale crime data (re-fetch if older than 30 days) ──
async function refreshStaleCrimeData() {
  const { collectForProperty } = require('./collect-crime');

  const { rows } = await pool.query(`
    SELECT DISTINCT p.id, p.suburb, p.city, ard.data_date
    FROM properties p
    JOIN area_risk_data ard ON ard.suburb ILIKE p.suburb AND ard.city ILIKE p.city AND ard.risk_type = 'crime_detailed'
    WHERE ard.data_date < NOW() - INTERVAL '30 days'
    ORDER BY ard.data_date ASC
    LIMIT 20
  `);

  await log(`Refresh: ${rows.length} properties with stale crime data (>30 days)`);
  let refreshed = 0;

  for (const prop of rows) {
    try {
      const result = await collectForProperty(prop.id);
      if (result && !result.error) {
        refreshed++;
        await log(`  Refresh OK: ${prop.suburb}`);
      }
    } catch (err) {
      await log(`  Refresh ERROR: ${prop.suburb} — ${err.message}`);
    }
    await sleep(BATCH_DELAY);
  }

  await log(`Refresh complete: ${refreshed} updated`);
  return { refreshed };
}

// ── Main ──
async function main() {
  await log('=== Nightly Collection Started ===');
  const start = Date.now();

  try {
    // Run in order of priority
    const crime = await collectCrimeData();
    const solar = await collectSolarData();
    const water = await collectWaterData();
    const discovery = await discoverNewListings();
    const refresh = await refreshStaleCrimeData();

    const elapsed = Math.round((Date.now() - start) / 1000);
    await log(`=== Nightly Collection Complete (${elapsed}s) ===`);
    await log(`  Crime: ${crime.success} OK, ${crime.failed} failed`);
    await log(`  Solar: ${solar.success} OK, ${solar.failed} failed`);
    await log(`  Water: ${water.success} OK, ${water.failed} failed`);
    await log(`  New PP listings: ${discovery.newFound}`);
    await log(`  Refreshed: ${refresh.refreshed}`);

    // Store run summary
    await pool.query(`
      INSERT INTO api_costs (service, endpoint, cost_usd, cost_zar, model)
      VALUES ('nightly_run', 'summary', 0, 0, $1)`,
      [JSON.stringify({ crime, solar, water, discovery, refresh, elapsed })]
    );
  } catch (err) {
    await log(`FATAL: ${err.message}`);
    console.error(err);
  }

  await pool.end();
}

main();
