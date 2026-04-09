#!/usr/bin/env node
/**
 * Re-embed all RAG chunks with the current embedding model.
 * Run after changing the embedding model in rag.js.
 *
 * Usage: node reembed-all.js
 *
 * This updates the embedding vector for every chunk without changing
 * any other data. Takes ~30 minutes for 13K chunks.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
const pool = require('./db');
const { embedText, warmup, getModelInfo } = require('./rag');

async function main() {
  console.log('[reembed] Warming up embedding model...');
  await warmup();
  const info = getModelInfo();
  console.log(`[reembed] Model: ${info.model} (${info.dims} dims)`);

  const { rows: countResult } = await pool.query('SELECT COUNT(*) as cnt FROM rag_chunks');
  const total = parseInt(countResult[0].cnt);
  console.log(`[reembed] Re-embedding ${total} chunks...\n`);

  const BATCH = 100;
  let processed = 0;
  let offset = 0;

  while (true) {
    const { rows: chunks } = await pool.query(
      'SELECT id, text FROM rag_chunks ORDER BY id LIMIT $1 OFFSET $2',
      [BATCH, offset]
    );
    if (chunks.length === 0) break;

    for (const chunk of chunks) {
      const embedding = await embedText(chunk.text, false);
      const vecStr = `[${embedding.join(',')}]`;
      await pool.query(
        'UPDATE rag_chunks SET embedding = $1::vector, updated_at = NOW() WHERE id = $2',
        [vecStr, chunk.id]
      );
      processed++;
    }

    offset += BATCH;
    const pct = Math.round((processed / total) * 100);
    const elapsed = Math.round(process.uptime());
    const rate = Math.round(processed / Math.max(elapsed, 1) * 60);
    console.log(`[reembed] ${processed}/${total} (${pct}%) — ${rate} chunks/min`);
  }

  console.log(`\n[reembed] Done. ${processed} chunks re-embedded with ${info.model}`);
  await pool.end();
}

main().catch(err => { console.error(err); pool.end(); process.exit(1); });
