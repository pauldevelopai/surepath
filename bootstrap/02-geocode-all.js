#!/usr/bin/env node
/**
 * PHASE 2 — Batch geocode all properties missing lat/lng
 *
 * Calls Google Maps Geocoding API for each property without coordinates.
 * Updates: lat, lng, address_normalised, suburb, city, province.
 *
 * Usage:
 *   node bootstrap/02-geocode-all.js              # Process all un-geocoded
 *   node bootstrap/02-geocode-all.js --limit 100  # Process max 100
 *   node bootstrap/02-geocode-all.js --dry-run    # Show what would be geocoded
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const pool = require('../db');
const { geocode } = require('../maps');

const DELAY_MS = 200; // Google allows ~50 req/sec on paid, but be polite
const BATCH_SIZE = 50; // Commit progress every N records

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const args = process.argv.slice(2);
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1]) : null;
  const dryRun = args.includes('--dry-run');

  if (!process.env.GOOGLE_MAPS_API_KEY) {
    console.error('ERROR: GOOGLE_MAPS_API_KEY not set in .env');
    console.log('Get one at: https://console.cloud.google.com/google/maps-apis');
    console.log('Enable: Geocoding API');
    console.log('Free tier: 40,000 requests/month');
    await pool.end();
    process.exit(1);
  }

  // Find properties without coordinates
  let sql = 'SELECT id, address_raw, suburb, city FROM properties WHERE lat IS NULL ORDER BY id';
  if (limit) sql += ` LIMIT ${limit}`;

  const { rows } = await pool.query(sql);
  console.log(`Found ${rows.length} properties without coordinates`);

  if (dryRun) {
    for (const r of rows.slice(0, 20)) {
      console.log(`  Would geocode: ${r.address_raw}`);
    }
    if (rows.length > 20) console.log(`  ... and ${rows.length - 20} more`);
    await pool.end();
    return;
  }

  let success = 0;
  let failed = 0;
  let skipped = 0;

  for (let i = 0; i < rows.length; i++) {
    const prop = rows[i];

    // Build search string
    let searchAddr = prop.address_raw;
    if (prop.city && !searchAddr.toLowerCase().includes(prop.city.toLowerCase())) {
      searchAddr += `, ${prop.city}`;
    }
    searchAddr += ', South Africa';

    try {
      const geo = await geocode(searchAddr);

      if (!geo) {
        console.log(`  [${i + 1}/${rows.length}] FAIL: ${prop.address_raw}`);
        failed++;
        continue;
      }

      await pool.query(
        `UPDATE properties SET
           lat = $1, lng = $2,
           address_normalised = $3,
           suburb = COALESCE($4, suburb),
           city = COALESCE($5, city),
           province = COALESCE($6, province)
         WHERE id = $7`,
        [geo.lat, geo.lng, geo.formatted_address, geo.suburb, geo.city, geo.province, prop.id]
      );

      const { recordSource } = require('../provenance');
      const mapsUrl = `https://www.google.com/maps/@${geo.lat},${geo.lng},18z`;
      await recordSource(prop.id, 'Google Maps Geocoding API', mapsUrl, 'verified', ['lat', 'lng', 'address_normalised', 'suburb', 'city', 'province']);

      success++;
      console.log(`  [${i + 1}/${rows.length}] OK: ${prop.address_raw} → ${geo.lat}, ${geo.lng} (${geo.suburb || 'no suburb'})`);
    } catch (err) {
      console.error(`  [${i + 1}/${rows.length}] ERROR: ${prop.address_raw} — ${err.message}`);
      failed++;
    }

    await sleep(DELAY_MS);

    // Progress every batch
    if ((i + 1) % BATCH_SIZE === 0) {
      console.log(`\n  --- Progress: ${success} geocoded, ${failed} failed, ${rows.length - i - 1} remaining ---\n`);
    }
  }

  console.log(`\n=== GEOCODING COMPLETE ===`);
  console.log(`  Success: ${success}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Skipped: ${skipped}`);

  const { rows: stats } = await pool.query(
    'SELECT COUNT(*) FILTER (WHERE lat IS NOT NULL) AS geocoded, COUNT(*) AS total FROM properties'
  );
  console.log(`  Database: ${stats[0].geocoded}/${stats[0].total} properties have coordinates`);

  await pool.end();
}

main().catch(err => {
  console.error('Fatal:', err);
  pool.end();
  process.exit(1);
});
