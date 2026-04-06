const pool = require('./db');

/**
 * RAG Intelligence Hub — additive migration (safe to run against live DB).
 * Only creates what doesn't already exist in the schema.
 */
async function migrateRAG() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ─── Curated defect knowledge base (Vision & Condition) ───────────
    // Per-property findings live in property_images.vision_analysis already.
    // This table is the canonical library that feeds INTO vision prompts.
    await client.query(`
      CREATE TABLE IF NOT EXISTS rag_knowledge_entries (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        visual_indicators TEXT,
        sa_context TEXT,
        severity INTEGER CHECK (severity BETWEEN 1 AND 5),
        cost_min_zar INTEGER,
        cost_max_zar INTEGER,
        category TEXT,
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('active', 'draft')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // ─── Quality comparison runs (Nico with vs without RAG) ───────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS rag_quality_runs (
        id SERIAL PRIMARY KEY,
        run_type TEXT NOT NULL CHECK (run_type IN ('isolated', 'combined')),
        rag_system TEXT CHECK (rag_system IN ('vision_condition', 'property_intelligence')),
        query_text TEXT,
        image_url TEXT,
        property_id INTEGER REFERENCES properties(id),
        rag_context JSONB,
        response_without_rag TEXT,
        response_with_rag TEXT,
        score_specificity INTEGER CHECK (score_specificity BETWEEN 1 AND 5),
        score_accuracy INTEGER CHECK (score_accuracy BETWEEN 1 AND 5),
        score_actionability INTEGER CHECK (score_actionability BETWEEN 1 AND 5),
        score_consistency INTEGER CHECK (score_consistency BETWEEN 1 AND 5),
        notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // ─── Indexes ──────────────────────────────────────────────────────
    await client.query(`CREATE INDEX IF NOT EXISTS idx_rag_kb_status ON rag_knowledge_entries(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_rag_kb_category ON rag_knowledge_entries(category)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_rag_quality_type ON rag_quality_runs(run_type, created_at)`);

    await client.query('COMMIT');
    console.log('RAG tables created successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('RAG migration failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = migrateRAG;

if (require.main === module) {
  migrateRAG()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
