#!/usr/bin/env node
// RUN THIS ONCE before deploying the new WhatsApp flow:
//   node migrate-conversations.js

require('dotenv').config();
const pool = require('./db');

async function migrate() {
  console.log('Running conversations table migration...');
  await pool.query(`
    ALTER TABLE conversations
    ADD COLUMN IF NOT EXISTS tease_data JSONB,
    ADD COLUMN IF NOT EXISTS listing_url TEXT,
    ADD COLUMN IF NOT EXISTS pp_listing_id TEXT;
  `);
  console.log('Migration complete.');
  await pool.end();
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
