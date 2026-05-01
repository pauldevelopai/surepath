const fs = require('fs');
const path = require('path');
const pool = require('./db');

async function migrate() {
  if (process.env.ALLOW_DESTRUCTIVE_MIGRATE !== 'true') {
    console.error('');
    console.error('  REFUSING TO RUN: migrate.js DROPs and recreates every core table.');
    console.error('  The live DB has tables and columns added outside schema.sql that would be lost');
    console.error('  (see `node schema-audit.js` for the current drift — properties alone has 70+');
    console.error('  manually-added columns that this script would destroy).');
    console.error('');
    console.error('  If you genuinely want to wipe and recreate, opt in explicitly:');
    console.error('    ALLOW_DESTRUCTIVE_MIGRATE=true node migrate.js');
    console.error('');
    process.exit(1);
  }

  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const convSql = fs.readFileSync(path.join(__dirname, 'conversations.sql'), 'utf8');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Drop all tables and types if they exist (clean slate)
    await client.query(`
      DROP TABLE IF EXISTS conversations CASCADE;
      DROP TABLE IF EXISTS api_usage CASCADE;
      DROP TABLE IF EXISTS api_clients CASCADE;
      DROP TABLE IF EXISTS trades_jobs CASCADE;
      DROP TABLE IF EXISTS crime_incidents CASCADE;
      DROP TABLE IF EXISTS content_posts CASCADE;
      DROP TABLE IF EXISTS property_images CASCADE;
      DROP TABLE IF EXISTS orders CASCADE;
      DROP TABLE IF EXISTS property_reports CASCADE;
      DROP TABLE IF EXISTS deeds_data CASCADE;
      DROP TABLE IF EXISTS properties CASCADE;
      DROP TYPE IF EXISTS report_status CASCADE;
      DROP TYPE IF EXISTS decision_type CASCADE;
      DROP TYPE IF EXISTS risk_level CASCADE;
      DROP TYPE IF EXISTS content_status CASCADE;
      DROP TYPE IF EXISTS api_tier CASCADE;
    `);

    await client.query(sql);
    await client.query(convSql);
    await client.query('COMMIT');
    console.log('Schema created successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = migrate;

if (require.main === module) {
  migrate()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
