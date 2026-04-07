/**
 * Seed rag_chunks from rag_knowledge_entries (articles).
 * Run once, then re-run whenever KB entries change.
 *
 * Usage: node seed-knowledge.js
 */
require('dotenv').config();
const pool = require('./db');
const { upsertChunk, warmup } = require('./rag');

async function seedKnowledge() {
  console.log('[seed-knowledge] Warming up embedding model...');
  await warmup();

  const { rows } = await pool.query(
    `SELECT id, name, description, visual_indicators, sa_context, severity,
            cost_min_zar, cost_max_zar, category
     FROM rag_knowledge_entries WHERE status = 'active'`
  );

  console.log(`[seed-knowledge] Found ${rows.length} active articles to embed`);

  let count = 0;
  for (const row of rows) {
    const textParts = [
      `${row.name}. Category: ${row.category}. Severity: ${row.severity}/5.`,
    ];
    if (row.description) textParts.push(row.description);
    if (row.visual_indicators) textParts.push(`Visual indicators: ${row.visual_indicators}.`);
    if (row.sa_context) textParts.push(`SA context: ${row.sa_context}.`);
    if (row.cost_min_zar) textParts.push(`Repair cost: R${row.cost_min_zar}–R${row.cost_max_zar}.`);

    const text = textParts.join('\n');
    const metadata = {
      name: row.name,
      category: row.category,
      severity: row.severity,
      description: row.description,
      visual_indicators: row.visual_indicators,
      sa_context: row.sa_context,
      cost_min_zar: row.cost_min_zar,
      cost_max_zar: row.cost_max_zar,
    };

    const id = await upsertChunk(text, metadata, 'knowledge', 'rag_knowledge_entries', row.id, `knowledge:${row.id}`);
    count++;
    console.log(`  [${count}/${rows.length}] ${row.name} → chunk ${id}`);
  }

  console.log(`\n[seed-knowledge] Done: ${count} knowledge chunks embedded`);
}

seedKnowledge()
  .then(() => pool.end())
  .catch(err => { console.error(err); pool.end(); process.exit(1); });
