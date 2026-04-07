require("dotenv").config();
const pool = require("./db");
const { embedText } = require("./rag");

(async () => {
  const embedding = await embedText("residential house exterior, concrete tile roof, rendered walls, damp, cracks, security. South African property defects.");
  const vecStr = "[" + embedding.join(",") + "]";

  // Force sequential scan (bypass HNSW index)
  await pool.query("SET enable_indexscan = off");
  await pool.query("SET enable_bitmapscan = off");

  console.log("\n=== With sequential scan (no HNSW index) ===\n");
  for (const layer of ['knowledge', 'live', 'crime', 'security', 'security_company', 'evidence', 'vision', 'feedback', 'report', 'property']) {
    const { rows } = await pool.query(
      `SELECT id, layer, 1 - (embedding <=> $1::vector) AS score
       FROM rag_chunks WHERE layer = $2
       ORDER BY embedding <=> $1::vector LIMIT 2`,
      [vecStr, layer]
    );
    console.log(`${layer.padEnd(20)} ${rows.length > 0 ? rows.map(r => Number(r.score).toFixed(3)).join(", ") : "EMPTY"}`);
  }

  // Re-enable index
  await pool.query("SET enable_indexscan = on");
  await pool.query("SET enable_bitmapscan = on");

  console.log("\n=== With HNSW index ===\n");
  for (const layer of ['knowledge', 'live', 'crime', 'security', 'security_company', 'evidence', 'vision', 'feedback', 'report', 'property']) {
    const { rows } = await pool.query(
      `SELECT id, layer, 1 - (embedding <=> $1::vector) AS score
       FROM rag_chunks WHERE layer = $2
       ORDER BY embedding <=> $1::vector LIMIT 2`,
      [vecStr, layer]
    );
    console.log(`${layer.padEnd(20)} ${rows.length > 0 ? rows.map(r => Number(r.score).toFixed(3)).join(", ") : "EMPTY"}`);
  }

  process.exit(0);
})();
