const pool = require('./db');

/**
 * Holly Evidence — the WHY chain for every vision finding.
 * Additive migration, safe to run against live DB.
 */
async function migrateHolly() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS holly_evidence (
        id SERIAL PRIMARY KEY,

        -- What was analysed
        property_id INTEGER NOT NULL REFERENCES properties(id),
        image_id INTEGER NOT NULL REFERENCES property_images(id),
        image_url TEXT NOT NULL,

        -- What Holly observed
        finding_index INTEGER NOT NULL,
        category TEXT NOT NULL,
        observation TEXT NOT NULL,
        visual_location TEXT,

        -- What Holly matched it to
        kb_entry_id INTEGER REFERENCES rag_knowledge_entries(id),
        kb_match_reason TEXT,

        -- What corroborated or contradicted
        corroborating_data JSONB,
        corroboration_effect TEXT,

        -- What Holly determined
        confidence_tier INTEGER NOT NULL CHECK (confidence_tier BETWEEN 1 AND 4),
        tier_reason TEXT NOT NULL,
        severity TEXT NOT NULL,

        -- What language Holly produced
        output_language TEXT NOT NULL,

        -- What Holly could not determine
        limitations TEXT,

        -- Cost
        cost_min_zar INTEGER,
        cost_max_zar INTEGER,
        cost_source TEXT,

        -- Metadata
        model_used TEXT NOT NULL,
        prompt_version TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query('CREATE INDEX IF NOT EXISTS idx_holly_property ON holly_evidence(property_id, created_at)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_holly_image ON holly_evidence(image_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_holly_kb ON holly_evidence(kb_entry_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_holly_tier ON holly_evidence(confidence_tier)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_holly_category ON holly_evidence(category, severity)');

    await client.query('COMMIT');
    console.log('Holly evidence table created successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Holly migration failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = migrateHolly;

if (require.main === module) {
  migrateHolly()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
