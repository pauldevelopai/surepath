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

    // ─── Vector RAG chunks (pgvector) ────────────────────────────────
    await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS rag_chunks (
        id SERIAL PRIMARY KEY,
        chunk_key TEXT UNIQUE NOT NULL,
        text TEXT NOT NULL,
        embedding vector(384) NOT NULL,
        layer TEXT NOT NULL,
        source_table TEXT,
        source_id INTEGER,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_rag_chunks_embedding ON rag_chunks USING hnsw (embedding vector_cosine_ops)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_rag_chunks_layer ON rag_chunks(layer)`);

    // ─── RAG retrieval log ───────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS rag_retrieval_log (
        id SERIAL PRIMARY KEY,
        query_text TEXT NOT NULL,
        property_id INTEGER,
        suburb TEXT,
        chunks_returned INTEGER NOT NULL DEFAULT 0,
        layers_hit TEXT[] NOT NULL DEFAULT '{}',
        avg_score NUMERIC(5,4),
        top_score NUMERIC(5,4),
        fallback_used BOOLEAN NOT NULL DEFAULT false,
        duration_ms INTEGER,
        chunk_ids INTEGER[] DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_rag_log_created ON rag_retrieval_log(created_at DESC)`);

    // ─── Additive columns (safe to run multiple times) ───────────────
    await client.query(`ALTER TABLE rag_knowledge_entries ADD COLUMN IF NOT EXISTS source_url TEXT`);
    await client.query(`ALTER TABLE rag_knowledge_entries ADD COLUMN IF NOT EXISTS image_id INTEGER`);
    await client.query(`ALTER TABLE rag_knowledge_entries ADD COLUMN IF NOT EXISTS image_url TEXT`);
    await client.query(`ALTER TABLE rag_knowledge_entries ADD COLUMN IF NOT EXISTS property_id INTEGER`);
    await client.query(`ALTER TABLE rag_knowledge_entries ADD COLUMN IF NOT EXISTS original_finding JSONB`);

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
