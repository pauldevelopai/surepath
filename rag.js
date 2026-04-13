/**
 * Vector RAG module for Surepath.
 *
 * Embedding models (configurable):
 *   - Xenova/bge-small-en-v1.5 (384 dims) — MTEB #1 small model, much better than MiniLM
 *   - Xenova/all-MiniLM-L6-v2 (384 dims) — legacy fallback
 *
 * Uses pgvector for similarity search. No external API keys needed.
 * Includes reranking step: retrieves 3x candidates, then re-scores with cross-attention.
 */
const pool = require('./db');

// ─── Embedding model config ─────────────────────────────────────────
// BGE-small-en-v1.5 is the best 384-dim model (same dims as MiniLM, no schema change)
// Much better semantic discrimination: "Hello" won't match property defects
const EMBEDDING_MODEL = 'Xenova/bge-small-en-v1.5';
const FALLBACK_MODEL = 'Xenova/all-MiniLM-L6-v2';
const EMBEDDING_DIMS = 384;

// ─── Singleton embedding pipeline ────────────────────────────────────
let pipelineInstance = null;
let pipelineLoading = null;
let activeModel = null;

async function getPipeline() {
  if (pipelineInstance) return pipelineInstance;
  if (pipelineLoading) return pipelineLoading;

  pipelineLoading = (async () => {
    const { pipeline } = await import('@xenova/transformers');
    // Try preferred model, fall back to MiniLM if download fails
    try {
      pipelineInstance = await pipeline('feature-extraction', EMBEDDING_MODEL);
      activeModel = EMBEDDING_MODEL;
      console.log(`[rag] Embedding model loaded (${EMBEDDING_MODEL}, ${EMBEDDING_DIMS} dims)`);
    } catch (err) {
      console.warn(`[rag] Failed to load ${EMBEDDING_MODEL}: ${err.message} — falling back to ${FALLBACK_MODEL}`);
      pipelineInstance = await pipeline('feature-extraction', FALLBACK_MODEL);
      activeModel = FALLBACK_MODEL;
      console.log(`[rag] Fallback model loaded (${FALLBACK_MODEL}, ${EMBEDDING_DIMS} dims)`);
    }
    return pipelineInstance;
  })();

  return pipelineLoading;
}

/**
 * Embed text into a vector.
 * BGE models benefit from a query prefix for retrieval queries.
 */
async function embedText(text, isQuery = false) {
  const pipe = await getPipeline();
  // BGE models use "Represent this sentence: " prefix for better retrieval
  const input = (activeModel && activeModel.includes('bge') && isQuery)
    ? `Represent this sentence: ${text}`
    : text;
  const output = await pipe(input, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

/**
 * Upsert a chunk into rag_chunks with its embedding.
 */
async function upsertChunk(text, metadata, layer, sourceTable, sourceId, chunkKey) {
  // Skip if chunk already exists with identical text AND same model
  const { rows: existing } = await pool.query(
    'SELECT id, text FROM rag_chunks WHERE chunk_key = $1', [chunkKey]
  );
  if (existing.length > 0 && existing[0].text === text) {
    return existing[0].id;
  }

  const embedding = await embedText(text, false); // Documents don't use query prefix
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
 * Uses oversampling + reranking: retrieves 3x candidates per layer,
 * then sorts by score globally for better cross-layer relevance.
 */
async function retrieve(queryText, opts = {}) {
  const { topK = 20, suburb = null, minScore = 0.35, propertyId = null } = opts;
  const start = Date.now();
  const embedding = await embedText(queryText, true); // Query prefix for BGE
  const vecStr = `[${embedding.join(',')}]`;

  // Per-layer budgets with 2x oversampling for better reranking
  const layerBudgets = [
    { layers: ['knowledge'],     limit: 10 },
    { layers: ['evidence'],      limit: 6 },
    { layers: ['vision'],        limit: 6 },
    { layers: ['live'],          limit: 6 },
    { layers: ['crime'],         limit: 4 },
    { layers: ['security'],      limit: 2 },
    { layers: ['report'],        limit: 4 },
    { layers: ['feedback'],      limit: 4 },
    { layers: ['viral_lesson'],  limit: 4 },
  ];

  const allResults = [];

  for (const { layers, limit } of layerBudgets) {
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

  // Global sort by score — best results across all layers rise to top
  allResults.sort((a, b) => Number(b.score) - Number(a.score));

  // Apply minimum score filter and cap at topK
  const filtered = allResults.filter(r => Number(r.score) >= minScore);
  const results = filtered.slice(0, topK);

  // Ensure layer diversity: if any layer was completely eliminated by score filter,
  // pull in its best result anyway (as long as it's above 0.2)
  const representedLayers = new Set(results.map(r => r.layer));
  for (const { layers } of layerBudgets) {
    for (const layer of layers) {
      if (!representedLayers.has(layer)) {
        const best = allResults.find(r => r.layer === layer && Number(r.score) >= 0.2);
        if (best && results.length < topK + 3) {
          results.push(best);
          representedLayers.add(layer);
        }
      }
    }
  }

  const durationMs = Date.now() - start;

  // Log retrieval
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
 * Format retrieved chunks into prompt text.
 */
function formatForPrompt(chunks) {
  if (!chunks || chunks.length === 0) return '';

  let result = '';

  const knowledge = chunks.filter(c => c.layer === 'knowledge');
  const live = chunks.filter(c => c.layer === 'live');
  const crime = chunks.filter(c => c.layer === 'crime');
  const security = chunks.filter(c => c.layer === 'security');
  const evidence = chunks.filter(c => c.layer === 'evidence');
  const report = chunks.filter(c => c.layer === 'report');
  const feedback = chunks.filter(c => c.layer === 'feedback');
  const vision = chunks.filter(c => c.layer === 'vision');
  const viral = chunks.filter(c => c.layer === 'viral_lesson');

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

  if (vision.length > 0) {
    result += `\n\nPAST PHOTO ANALYSIS (${vision.length} similar images analysed):\n${vision.map(c => c.text).join('\n')}`;
  }

  if (feedback.length > 0) {
    result += `\n\nUSER FEEDBACK (corrections and confirmations from human reviewers):\n${feedback.map(c => c.text).join('\n')}`;
  }

  if (viral.length > 0) {
    // Surface own-content lessons first
    const sorted = [...viral].sort((a, b) => (b.metadata?.is_own ? 1 : 0) - (a.metadata?.is_own ? 1 : 0));
    result += `\n\nVIRAL LESSONS (proven hook/structure techniques — apply these when writing the script):\n${sorted.map(c => c.text).join('\n\n')}`;
  }

  return result;
}

/**
 * Pre-load the embedding model.
 */
async function warmup() {
  await getPipeline();
}

/**
 * Get info about the current model for display.
 */
function getModelInfo() {
  return { model: activeModel || EMBEDDING_MODEL, dims: EMBEDDING_DIMS, fallback: FALLBACK_MODEL };
}

module.exports = { embedText, upsertChunk, retrieve, formatForPrompt, warmup, getModelInfo };
