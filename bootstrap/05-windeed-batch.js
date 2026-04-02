#!/usr/bin/env node
/**
 * PHASE 5 — Batch Windeed lookups for properties missing deeds data
 *
 * Selectively looks up ERF numbers and deeds data via Windeed API.
 * Prioritises properties in suburbs with B2B client interest.
 *
 * Usage:
 *   node bootstrap/05-windeed-batch.js                         # All without deeds
 *   node bootstrap/05-windeed-batch.js --suburb "Gardens"      # Specific suburb
 *   node bootstrap/05-windeed-batch.js --limit 50              # Max 50 lookups
 *   node bootstrap/05-windeed-batch.js --dry-run               # Show what would be looked up
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const pool = require('../db');
const windeed = require('../windeed');

const DELAY_MS = 3000; // Windeed rate limit — be conservative

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const args = process.argv.slice(2);
  const limitIdx = args.indexOf('--limit');
  const suburbIdx = args.indexOf('--suburb');
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1]) : null;
  const suburb = suburbIdx >= 0 ? args[suburbIdx + 1] : null;
  const dryRun = args.includes('--dry-run');

  if (!process.env.WINDEED_API_KEY) {
    console.error('ERROR: WINDEED_API_KEY not set in .env');
    console.log('Get one at: https://www.windeed.co.za');
    console.log('\nWithout Windeed, properties will have:');
    console.log('  - No verified ERF numbers');
    console.log('  - No registered owner data');
    console.log('  - No transfer history');
    console.log('  - No municipal valuations');
    console.log('\nYou can still run phases 1-4 without it.');
    await pool.end();
    process.exit(1);
  }

  // Find properties without deeds data
  let sql = `
    SELECT p.id, p.address_raw, p.suburb, p.city, p.erf_number
    FROM properties p
    LEFT JOIN deeds_data d ON d.property_id = p.id
    WHERE d.id IS NULL
  `;
  const params = [];
  let idx = 1;

  if (suburb) {
    sql += ` AND p.suburb ILIKE $${idx++}`;
    params.push(`%${suburb}%`);
  }

  sql += ' ORDER BY p.id';
  if (limit) sql += ` LIMIT ${limit}`;

  const { rows: properties } = await pool.query(sql, params);
  console.log(`Found ${properties.length} properties without deeds data`);

  if (dryRun) {
    for (const p of properties.slice(0, 30)) {
      console.log(`  Would lookup: ${p.address_raw} (${p.suburb || 'no suburb'})`);
    }
    if (properties.length > 30) console.log(`  ... and ${properties.length - 30} more`);
    await pool.end();
    return;
  }

  let success = 0;
  let failed = 0;

  for (let i = 0; i < properties.length; i++) {
    const prop = properties[i];
    console.log(`[${i + 1}/${properties.length}] ${prop.address_raw}`);

    try {
      const result = await windeed.lookupAddress(prop.address_raw);

      if (!result) {
        console.log('  No results from Windeed');
        failed++;
        continue;
      }

      // If Windeed returned a real ERF, update the property
      if (result.erf_number && !result.erf_number.startsWith('UNVERIFIED')) {
        await pool.query(
          'UPDATE properties SET erf_number = $1, last_deeds_lookup = NOW() WHERE id = $2',
          [result.erf_number, prop.id]
        );
      }

      success++;
      console.log(`  OK: ERF ${result.erf_number} | Owner: ${result.registered_owner} | Municipal: R${result.municipal_value}`);
    } catch (err) {
      console.error(`  ERROR: ${err.message}`);
      failed++;
    }

    await sleep(DELAY_MS);
  }

  console.log(`\n=== WINDEED BATCH COMPLETE ===`);
  console.log(`  Success: ${success}`);
  console.log(`  Failed: ${failed}`);

  const { rows: stats } = await pool.query(`
    SELECT
      COUNT(*) AS total_properties,
      COUNT(d.id) AS with_deeds
    FROM properties p
    LEFT JOIN deeds_data d ON d.property_id = p.id
  `);
  console.log(`  Properties with deeds: ${stats[0].with_deeds}/${stats[0].total_properties}`);

  await pool.end();
}

main().catch(err => {
  console.error('Fatal:', err);
  pool.end();
  process.exit(1);
});
