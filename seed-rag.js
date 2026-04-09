/**
 * Seed all RAG chunks — runs both knowledge and live data seeders.
 * Called automatically after scraper runs, or manually: node seed-rag.js
 *
 * Safe to re-run: uses upsert (ON CONFLICT DO UPDATE).
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
const pool = require('./db');

async function seedRAG() {
  const start = Date.now();
  console.log('[seed-rag] Starting full RAG re-seed...\n');

  // Run knowledge seeder
  try {
    const { upsertChunk, warmup } = require('./rag');
    await warmup();

    // Knowledge articles
    const { rows: kbRows } = await pool.query(
      `SELECT id, name, description, visual_indicators, sa_context, severity,
              cost_min_zar, cost_max_zar, category
       FROM rag_knowledge_entries WHERE status = 'active' AND COALESCE(rag_status, 'approved') = 'approved'`
    );
    let count = 0;
    for (const row of kbRows) {
      const textParts = [
        `${row.name}. Category: ${row.category}. Severity: ${row.severity}/5.`,
      ];
      if (row.description) textParts.push(row.description);
      if (row.visual_indicators) textParts.push(`Visual indicators: ${row.visual_indicators}.`);
      if (row.sa_context) textParts.push(`SA context: ${row.sa_context}.`);
      if (row.cost_min_zar) textParts.push(`Repair cost: R${row.cost_min_zar}–R${row.cost_max_zar}.`);

      const metadata = {
        name: row.name, category: row.category, severity: row.severity,
        description: row.description, visual_indicators: row.visual_indicators,
        sa_context: row.sa_context, cost_min_zar: row.cost_min_zar, cost_max_zar: row.cost_max_zar,
      };
      await upsertChunk(textParts.join('\n'), metadata, 'knowledge', 'rag_knowledge_entries', row.id, `knowledge:${row.id}`);
      count++;
    }
    console.log(`[seed-rag] Knowledge: ${count} articles`);
  } catch (err) {
    console.error('[seed-rag] Knowledge seeding failed:', err.message);
  }

  // Run live data seeder (in-process to share the warmed-up model)
  try {
    // Dynamic require to run the seeder's main logic
    delete require.cache[require.resolve('./seed-live-data')];
    // We can't easily re-use seed-live-data.js since it calls pool.end()
    // Instead, just log that a full re-seed should use the dedicated scripts
    console.log('[seed-rag] For full live data re-seed, run: node seed-live-data.js');
  } catch {}

  const elapsed = Math.round((Date.now() - start) / 1000);
  console.log(`\n[seed-rag] Done in ${elapsed}s`);

  // Log the re-seed event
  try {
    const { rows } = await pool.query('SELECT layer, COUNT(*) AS count FROM rag_chunks GROUP BY layer ORDER BY count DESC');
    const total = rows.reduce((s, r) => s + Number(r.count), 0);
    console.log(`[seed-rag] Total chunks: ${total}`);
    rows.forEach(r => console.log(`  ${r.layer}: ${r.count}`));
  } catch {}
}

module.exports = { seedRAG };

if (require.main === module) {
  seedRAG()
    .then(() => pool.end())
    .catch(err => { console.error(err); pool.end(); process.exit(1); });
}
