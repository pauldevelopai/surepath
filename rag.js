/**
 * Vector RAG module for Surepath.
 *
 * Uses @xenova/transformers (all-MiniLM-L6-v2, 384 dims) for local embeddings
 * and pgvector for similarity search. No external API keys needed.
 */
const pool = require('./db');

// ─── Singleton embedding pipeline ────────────────────────────────────
let pipelineInstance = null;
let pipelineLoading = null;

async function getPipeline() {
  if (pipelineInstance) return pipelineInstance;
  if (pipelineLoading) return pipelineLoading;

  pipelineLoading = (async () => {
    const { pipeline } = await import('@xenova/transformers');
    pipelineInstance = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    console.log('[rag] Embedding model loaded (all-MiniLM-L6-v2, 384 dims)');
    return pipelineInstance;
  })();

  return pipelineLoading;
}

/**
 * Embed text into a 384-dimensional vector.
 * @param {string} text
 * @returns {Promise<number[]>}
 */
async function embedText(text) {
  const pipe = await getPipeline();
  const output = await pipe(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

/**
 * Upsert a chunk into rag_chunks with its embedding.
 * @param {string} text - The text to embed and store
 * @param {object} metadata - JSONB metadata (suburb, category, severity, etc.)
 * @param {string} layer - 'knowledge' | 'live' | 'crime' | 'security'
 * @param {string} sourceTable - Source table name
 * @param {number|null} sourceId - Source row ID (null for aggregates)
 * @param {string} chunkKey - Unique key for upsert (e.g. 'knowledge:42')
 * @returns {Promise<number>} The chunk ID
 */
async function upsertChunk(text, metadata, layer, sourceTable, sourceId, chunkKey) {
  const embedding = await embedText(text);
  const vecStr = `[${embedding.join(',')}]`;

  const { rows } = await pool.query(
    `INSERT INTO rag_chunks (chunk_key, text, embedding, layer, source_table, source_id, metadata, updated_at)
     VALUES ($1, $2, $3::vector, $4, $5, $6, $7, NOW())
     ON CONFLICT (chunk_key) DO UPDATE SET
       text = EXCLUDED.text,
       embedding = EXCLUDED.embedding,
       layer = EXCLUDED.layer,
       metadata = EXCLUDED.metadata,
       updated_at = NOW()
     RETURNING id`,
    [chunkKey, text, vecStr, layer, sourceTable, sourceId, JSON.stringify(metadata)]
  );

  return rows[0].id;
}

/**
 * Retrieve the most relevant chunks for a query, balanced across layers.
 *
 * Fetches per-layer to ensure knowledge articles (the most important for
 * photo analysis) aren't drowned out by the volume of property/security data.
 *
 * @param {string} queryText - The query to embed and search against
 * @param {object} [opts]
 * @param {number} [opts.topK=20] - Total results across all layers
 * @param {string} [opts.suburb] - Filter by metadata suburb (also includes chunks with no suburb)
 * @param {number} [opts.minScore=0.2] - Minimum cosine similarity (0-1)
 * @returns {Promise<Array<{id, text, layer, metadata, score}>>}
 */
async function retrieve(queryText, opts = {}) {
  const { topK = 20, suburb = null, minScore = 0.35, propertyId = null } = opts;
  const start = Date.now();
  const embedding = await embedText(queryText);
  const vecStr = `[${embedding.join(',')}]`;

  // Per-layer budgets — focus on data that helps photo ANALYSIS, not descriptions.
  // Knowledge, evidence, and vision findings are the most valuable for identifying defects.
  // Area data (live, crime) provides corroboration context.
  // Property listings and security companies are NOT useful for photo analysis — they dilute focus.
  const layerBudgets = [
    { layers: ['knowledge'],                      limit: 5 },
    { layers: ['evidence'],                       limit: 3 },
    { layers: ['vision'],                         limit: 3 },
    { layers: ['live'],                           limit: 3 },
    { layers: ['crime'],                          limit: 2 },
    { layers: ['security'],                       limit: 1 },
    { layers: ['report'],                         limit: 2 },
    { layers: ['feedback'],                       limit: 2 },
    // property and security_company are NOT included — they describe listings
    // and companies, not defects. Including them dilutes Nico's analysis focus.
  ];

  const allResults = [];

  for (const { layers, limit } of layerBudgets) {
    // Always pull the top results from every layer — don't let a high
    // minScore prevent area data, crime, security etc from contributing.
    // The final sort by score handles relevance ranking across layers.
    const { rows } = await pool.query(
      `SELECT id, text, layer, metadata,
              1 - (embedding <=> $1::vector) AS score
       FROM rag_chunks
       WHERE layer = ANY($2)
         AND ($3::text IS NULL OR metadata->>'suburb' ILIKE $3 OR metadata->>'suburb' IS NULL)
       ORDER BY embedding <=> $1::vector
       LIMIT $4`,
      [vecStr, layers, suburb, limit]
    );
    allResults.push(...rows);
  }

  // Sort all results by score descending, cap at topK
  allResults.sort((a, b) => Number(b.score) - Number(a.score));
  const results = allResults.slice(0, topK);
  const durationMs = Date.now() - start;

  // Log retrieval (fire-and-forget, never block)
  const layersHit = [...new Set(results.map(r => r.layer))];
  const scores = results.map(r => Number(r.score));
  const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  const topScore = scores.length > 0 ? scores[0] : 0;
  const chunkIds = results.map(r => r.id);

  pool.query(
    `INSERT INTO rag_retrieval_log (query_text, property_id, suburb, chunks_returned, layers_hit, avg_score, top_score, fallback_used, duration_ms, chunk_ids)
     VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8, $9)`,
    [queryText, propertyId, suburb, results.length, layersHit, avgScore.toFixed(4), topScore.toFixed(4), durationMs, chunkIds]
  ).catch(() => {});

  return results;
}

/**
 * Format retrieved chunks into prompt text matching Nico's expected format.
 * @param {Array} chunks - Results from retrieve()
 * @returns {string}
 */
function formatForPrompt(chunks) {
  if (!chunks || chunks.length === 0) return '';

  let result = '';

  const knowledge = chunks.filter(c => c.layer === 'knowledge');
  const live = chunks.filter(c => c.layer === 'live');
  const crime = chunks.filter(c => c.layer === 'crime');
  const security = chunks.filter(c => c.layer === 'security');
  const property = chunks.filter(c => c.layer === 'property');
  const evidence = chunks.filter(c => c.layer === 'evidence');
  const report = chunks.filter(c => c.layer === 'report');
  const feedback = chunks.filter(c => c.layer === 'feedback');

  if (knowledge.length > 0) {
    const entries = knowledge.map(c => {
      const m = c.metadata || {};
      const lines = [`DEFECT: ${m.name || 'Unknown'} [${m.category || 'unknown'}]`];
      if (m.visual_indicators) lines.push(`  LOOK FOR: ${m.visual_indicators}`);
      if (m.sa_context) lines.push(`  SA CONTEXT: ${m.sa_context}`);
      lines.push(`  SEVERITY: ${m.severity || '?'}/5`);
      if (m.cost_min_zar) lines.push(`  COST: R${m.cost_min_zar}–R${m.cost_max_zar}`);
      if (m.description && m.description !== m.visual_indicators) lines.push(`  DETAIL: ${m.description}`);
      return lines.join('\n');
    }).join('\n\n');

    result += `\n\nKNOWLEDGE BASE BRIEFING (${knowledge.length} entries — selected by relevance to this property)\nRead each entry before analysing. If you see visual evidence matching an entry, reference it by exact name in kb_entry_matched and use its cost range.\n\n${entries}`;
  }

  if (evidence.length > 0) {
    result += `\n\nPAST VISION FINDINGS (what you've found in similar properties — use to calibrate your analysis):\n${evidence.map(c => c.text).join('\n')}`;
  }

  if (report.length > 0) {
    result += `\n\nPAST REPORT DECISIONS (outcomes for similar properties):\n${report.map(c => c.text).join('\n')}`;
  }

  if (live.length > 0) {
    result += `\n\nAREA INTELLIGENCE (${live.length} data points):\n${live.map(c => c.text).join('\n')}`;
  }

  if (crime.length > 0) {
    result += `\n\nCRIME INTELLIGENCE:\n${crime.map(c => c.text).join('\n')}`;
  }

  if (security.length > 0) {
    result += `\n\nSECURITY COVERAGE:\n${security.map(c => c.text).join('\n')}`;
  }

  const vision = chunks.filter(c => c.layer === 'vision');

  if (vision.length > 0) {
    result += `\n\nPAST PHOTO ANALYSIS (${vision.length} similar images analysed):\n${vision.map(c => c.text).join('\n')}`;
  }

  if (feedback.length > 0) {
    result += `\n\nUSER FEEDBACK (corrections and confirmations from human reviewers):\n${feedback.map(c => c.text).join('\n')}`;
  }

  return result;
}

/**
 * Pre-load the embedding model (call during startup/seeding, not during requests).
 */
async function warmup() {
  await getPipeline();
}

module.exports = { embedText, upsertChunk, retrieve, formatForPrompt, warmup };
