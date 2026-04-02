#!/usr/bin/env node
// RUN ONCE: node migrate-deeds.js
// Adds columns for GVR data and DeedsWeb integration.
// Idempotent — safe to run multiple times.

require('dotenv').config();
const pool = require('./db');

async function migrate() {
  console.log('Running deeds/GVR migration...');

  // Properties table — GVR and deeds columns
  await pool.query(`
    ALTER TABLE properties ADD COLUMN IF NOT EXISTS owner_name_gvr TEXT;
    ALTER TABLE properties ADD COLUMN IF NOT EXISTS zoning TEXT;
    ALTER TABLE properties ADD COLUMN IF NOT EXISTS property_category TEXT;
    ALTER TABLE properties ADD COLUMN IF NOT EXISTS gvr_source TEXT;
    ALTER TABLE properties ADD COLUMN IF NOT EXISTS gvr_fetched_at TIMESTAMPTZ;
    ALTER TABLE properties ADD COLUMN IF NOT EXISTS lpi_code TEXT;
    ALTER TABLE properties ADD COLUMN IF NOT EXISTS owner_id_number TEXT;
    ALTER TABLE properties ADD COLUMN IF NOT EXISTS bond_holder TEXT;
    ALTER TABLE properties ADD COLUMN IF NOT EXISTS bond_amount INTEGER;
  `);

  // LPI index
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_properties_lpi
    ON properties(lpi_code) WHERE lpi_code IS NOT NULL;
  `);

  // Deeds data table — DeedsWeb columns
  await pool.query(`
    ALTER TABLE deeds_data ADD COLUMN IF NOT EXISTS raw_deedsweb_response JSONB;
    ALTER TABLE deeds_data ADD COLUMN IF NOT EXISTS lpi_code TEXT;
    ALTER TABLE deeds_data ADD COLUMN IF NOT EXISTS deeds_office TEXT;
    ALTER TABLE deeds_data ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'windeed';
  `);

  console.log('Migration complete.');
  await pool.end();
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
