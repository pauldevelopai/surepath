#!/usr/bin/env node
// RUN THIS ONCE before using the new vision modules:
//   node migrate-vision-modules.js

require('dotenv').config();
const pool = require('./db');

async function migrate() {
  console.log('Running vision modules migration...');

  await pool.query(`
    ALTER TABLE property_reports
    ADD COLUMN IF NOT EXISTS buyer_risk_index SMALLINT DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS temporal_change_analysis JSONB DEFAULT NULL;
  `);

  console.log('Migration complete — added buyer_risk_index and temporal_change_analysis to property_reports.');
  await pool.end();
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
