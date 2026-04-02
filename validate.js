const pool = require('./db');

async function validate() {
  const client = await pool.connect();
  try {
    console.log('=== FOREIGN KEY VALIDATION ===\n');

    // List all foreign keys in the database
    const { rows: fks } = await client.query(`
      SELECT
        tc.table_name AS from_table,
        kcu.column_name AS from_column,
        ccu.table_name AS to_table,
        ccu.column_name AS to_column,
        tc.constraint_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
      ORDER BY tc.table_name, kcu.column_name
    `);

    console.log('Foreign keys found:');
    for (const fk of fks) {
      console.log(`  ${fk.from_table}.${fk.from_column} -> ${fk.to_table}.${fk.to_column}  (${fk.constraint_name})`);
    }

    // Validate referential integrity — any orphans?
    console.log('\n=== REFERENTIAL INTEGRITY CHECK ===\n');

    const checks = [
      { table: 'deeds_data', col: 'property_id', ref: 'properties' },
      { table: 'property_reports', col: 'property_id', ref: 'properties' },
      { table: 'orders', col: 'property_id', ref: 'properties' },
      { table: 'orders', col: 'report_id', ref: 'property_reports' },
      { table: 'property_images', col: 'property_id', ref: 'properties' },
      { table: 'api_usage', col: 'client_id', ref: 'api_clients' },
      { table: 'api_usage', col: 'property_id', ref: 'properties' },
      { table: 'trades_jobs', col: 'property_id', ref: 'properties' },
    ];

    let allGood = true;
    for (const { table, col, ref } of checks) {
      const { rows } = await client.query(`
        SELECT COUNT(*) AS orphans FROM ${table} t
        WHERE t.${col} IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM ${ref} r WHERE r.id = t.${col})
      `);
      const orphans = parseInt(rows[0].orphans);
      const status = orphans === 0 ? 'OK' : `FAIL (${orphans} orphans)`;
      console.log(`  ${table}.${col} -> ${ref}: ${status}`);
      if (orphans > 0) allGood = false;
    }

    // Row counts
    console.log('\n=== ROW COUNTS ===\n');
    const tables = [
      'properties', 'deeds_data', 'property_reports', 'orders',
      'property_images', 'content_posts', 'api_clients', 'api_usage',
      'crime_incidents', 'trades_jobs'
    ];
    for (const t of tables) {
      const { rows } = await client.query(`SELECT COUNT(*) AS count FROM ${t}`);
      console.log(`  ${t}: ${rows[0].count}`);
    }

    // Spot check: report B2B fields populated
    console.log('\n=== B2B SCORE FIELDS (property_reports) ===\n');
    const { rows: reportRows } = await client.query(`
      SELECT id, property_id, insurance_risk_score, crime_risk_score,
             solar_suitability_score, maintenance_cost_estimate,
             decision, status
      FROM property_reports
    `);
    for (const r of reportRows) {
      console.log(`  Report #${r.id} (property ${r.property_id}):`);
      console.log(`    insurance_risk_score: ${r.insurance_risk_score}`);
      console.log(`    crime_risk_score: ${r.crime_risk_score}`);
      console.log(`    solar_suitability_score: ${r.solar_suitability_score}`);
      console.log(`    maintenance_cost_estimate: R${r.maintenance_cost_estimate}`);
      console.log(`    decision: ${r.decision}`);
      console.log(`    status: ${r.status}`);
    }

    console.log('\n' + (allGood ? 'All foreign keys valid.' : 'FOREIGN KEY ISSUES DETECTED.'));
  } finally {
    client.release();
  }
}

module.exports = validate;

if (require.main === module) {
  validate()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
