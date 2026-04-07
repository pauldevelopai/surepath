/**
 * Test RAG + Vision pipeline end-to-end.
 *
 * Tests the exact same code path that runs when a property report is generated:
 *   1. Loads property context from DB
 *   2. Builds the RAG query from property context
 *   3. Retrieves relevant chunks via vector similarity
 *   4. Builds Nico's full prompt with RAG context
 *   5. Sends a property photo to Claude Vision
 *   6. Shows the analysis result
 *
 * Usage:
 *   node test-rag-vision.js                          # Random property with photos
 *   node test-rag-vision.js --property-id 123        # Specific property
 *   node test-rag-vision.js --prompt-only             # Just show the prompt, don't call Claude
 *   node test-rag-vision.js --prompt-only --property-id 123
 *
 * This is the definitive test that RAG is working in production.
 */
require('dotenv').config();
const pool = require('./db');

const args = process.argv.slice(2);
const propertyIdArg = args.includes('--property-id') ? parseInt(args[args.indexOf('--property-id') + 1]) : null;
const promptOnly = args.includes('--prompt-only');

async function run() {
  // ─── 1. Pick a property ────────────────────────────────────────────
  let property;
  if (propertyIdArg) {
    const { rows } = await pool.query('SELECT * FROM properties WHERE id = $1', [propertyIdArg]);
    property = rows[0];
    if (!property) { console.error(`Property ${propertyIdArg} not found`); process.exit(1); }
  } else {
    // Pick a random property that has analysed photos
    const { rows } = await pool.query(`
      SELECT p.* FROM properties p
      JOIN property_images pi ON pi.property_id = p.id
      WHERE pi.vision_analysis IS NOT NULL
        AND pi.image_url LIKE 'https%'
        AND p.suburb IS NOT NULL
      ORDER BY RANDOM() LIMIT 1
    `);
    property = rows[0];
    if (!property) {
      // Fallback: any property with images
      const { rows: fallback } = await pool.query(`
        SELECT p.* FROM properties p
        JOIN property_images pi ON pi.property_id = p.id
        WHERE pi.image_url LIKE 'https%' AND p.suburb IS NOT NULL
        ORDER BY RANDOM() LIMIT 1
      `);
      property = fallback[0];
    }
    if (!property) { console.error('No properties with photos found'); process.exit(1); }
  }

  console.log('\n════════════════════════════════════════════════════════════');
  console.log('  TEST RAG + VISION PIPELINE');
  console.log('════════════════════════════════════════════════════════════\n');
  console.log(`Property: #${property.id} — ${property.address_raw || 'unknown'}`);
  console.log(`Suburb:   ${property.suburb || '?'}, ${property.city || '?'}`);
  console.log(`Era:      ${property.construction_era || 'unknown'}`);
  console.log(`Roof:     ${property.roof_material || 'unknown'}`);
  console.log(`Price:    ${property.asking_price ? 'R' + property.asking_price.toLocaleString() : '?'}`);

  // ─── 2. Get an image ──────────────────────────────────────────────
  const { rows: images } = await pool.query(
    `SELECT id, image_url FROM property_images
     WHERE property_id = $1 AND image_url LIKE 'https%'
     ORDER BY RANDOM() LIMIT 1`,
    [property.id]
  );
  if (images.length === 0) { console.error('No images found for this property'); process.exit(1); }
  console.log(`Image:    ${images[0].image_url}\n`);

  // ─── 3. Build property context (same as analysePropertyImages) ─────
  let propertyContext = null;
  try {
    const { rows } = await pool.query(
      `SELECT p.construction_era, p.suburb, p.city, p.roof_material, p.solar_installed,
              p.water_quality_score, p.dolomite_risk, p.flood_zone, p.security_visible,
              d.municipal_value, d.registered_owner
       FROM properties p
       LEFT JOIN deeds_data d ON d.property_id = p.id
       WHERE p.id = $1
       ORDER BY d.fetched_at DESC NULLS LAST LIMIT 1`,
      [property.id]
    );
    if (rows[0]) {
      propertyContext = { ...rows[0], propertyId: property.id };
      try {
        const { classifyEra, AGE_RISK_MATRIX } = require('./synthesis');
        const eraKey = classifyEra(rows[0].construction_era);
        if (eraKey && AGE_RISK_MATRIX[eraKey]) propertyContext.building_age_risk = AGE_RISK_MATRIX[eraKey];
      } catch {}
    }
  } catch (err) {
    console.error('Failed to load property context:', err.message);
  }

  // ─── 4. Test RAG retrieval directly ────────────────────────────────
  console.log('── RAG RETRIEVAL ──────────────────────────────────────────\n');
  try {
    const { retrieve, formatForPrompt } = require('./rag');

    const queryParts = [];
    if (propertyContext?.suburb) queryParts.push(propertyContext.suburb);
    if (propertyContext?.city) queryParts.push(propertyContext.city);
    if (propertyContext?.construction_era) queryParts.push(`${propertyContext.construction_era} construction era`);
    if (propertyContext?.roof_material) queryParts.push(`${propertyContext.roof_material} roof`);
    if (propertyContext?.dolomite_risk) queryParts.push('dolomite sinkhole risk');
    if (propertyContext?.building_age_risk?.asbestos) queryParts.push('asbestos risk pre-1990');
    const queryText = queryParts.length > 0
      ? queryParts.join(', ') + '. South African property defects and risks.'
      : 'South African property defects, damp, roof, walls, electrical, plumbing';

    console.log(`Query: "${queryText}"\n`);

    const start = Date.now();
    const chunks = await retrieve(queryText, {
      topK: 20,
      suburb: propertyContext?.suburb || null,
      minScore: 0.35,
      propertyId: property.id,
    });
    const elapsed = Date.now() - start;

    console.log(`Retrieved ${chunks.length} chunks in ${elapsed}ms\n`);

    // Show chunks by layer
    const byLayer = {};
    for (const c of chunks) {
      if (!byLayer[c.layer]) byLayer[c.layer] = [];
      byLayer[c.layer].push(c);
    }
    for (const [layer, layerChunks] of Object.entries(byLayer)) {
      console.log(`  [${layer}] ${layerChunks.length} chunks:`);
      for (const c of layerChunks) {
        const score = Number(c.score).toFixed(3);
        const preview = c.text.substring(0, 80).replace(/\n/g, ' ');
        console.log(`    ${score} — ${preview}...`);
      }
    }

    const formatted = formatForPrompt(chunks);
    console.log(`\n  Formatted prompt context: ${formatted.length} chars`);
    console.log(`  Sections: ${(formatted.match(/\n\n[A-Z]/g) || []).length}`);
  } catch (err) {
    console.error('RAG retrieval failed:', err.message);
    console.log('(Nico will fall back to dumping all KB entries)');
  }

  // ─── 5. Build full Nico prompt ─────────────────────────────────────
  console.log('\n── NICO PROMPT ────────────────────────────────────────────\n');
  const { getNicoPrompt } = require('./vision');
  const fullPrompt = await getNicoPrompt(propertyContext);
  console.log(`Full prompt: ${fullPrompt.length} chars`);

  // Show which sections are in the prompt
  const sections = fullPrompt.match(/\n\n[A-Z][A-Z ]+[:(]/g) || [];
  console.log(`Sections found: ${sections.length}`);
  for (const s of sections) console.log(`  ${s.trim()}`);

  if (promptOnly) {
    console.log('\n── FULL PROMPT (--prompt-only mode) ──────────────────────\n');
    console.log(fullPrompt);
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('  PROMPT-ONLY MODE — skipping Claude Vision call');
    console.log('═══════════════════════════════════════════════════════════\n');
    return;
  }

  // ─── 6. Run Claude Vision ──────────────────────────────────────────
  console.log('\n── CLAUDE VISION ANALYSIS ─────────────────────────────────\n');
  console.log('Downloading image and sending to Claude...');

  const vision = require('./vision');
  const downloadImage = vision.downloadImage;
  const detectMediaType = vision.detectMediaType;
  const buffer = await downloadImage(images[0].image_url);
  const mediaType = detectMediaType(images[0].image_url, buffer);
  const base64 = buffer.toString('base64');
  console.log(`Image: ${buffer.length} bytes, ${mediaType}`);

  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic();

  const start = Date.now();
  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    system: fullPrompt,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
        { type: 'text', text: 'Analyse this property photo.' },
      ],
    }],
  });
  const elapsed = Date.now() - start;

  const response = message.content[0].type === 'text' ? message.content[0].text : '';
  console.log(`\nClaude responded in ${elapsed}ms (${message.usage.input_tokens} in, ${message.usage.output_tokens} out)`);

  // Try to parse as JSON
  try {
    let json = response;
    if (json.includes('```')) json = json.replace(/```(?:json)?\s*/g, '').replace(/```/g, '');
    const parsed = JSON.parse(json);
    const findings = parsed.findings || [];
    console.log(`\nPhoto type: ${parsed.photo_type || '?'}`);
    console.log(`Findings: ${findings.length}\n`);

    for (let i = 0; i < findings.length; i++) {
      const f = findings[i];
      console.log(`  Finding ${i + 1}: [${f.category}] ${f.severity}`);
      console.log(`    See:    ${(f.what_i_see || '').substring(0, 100)}`);
      console.log(`    Defect: ${f.defect_or_risk || 'none'}`);
      if (f.kb_entry_matched) console.log(`    KB:     ${f.kb_entry_matched} — ${f.kb_match_reason || ''}`);
      console.log(`    Tier:   ${f.confidence_tier} — ${(f.tier_reason || '').substring(0, 80)}`);
      console.log(`    Means:  ${(f.what_it_means || '').substring(0, 120)}`);
      if (f.estimated_repair_cost_zar?.min) console.log(`    Cost:   R${f.estimated_repair_cost_zar.min}–R${f.estimated_repair_cost_zar.max}`);
      console.log('');
    }
  } catch {
    console.log('\n[Raw response — could not parse as JSON]');
    console.log(response.substring(0, 2000));
  }

  // ─── 7. Check RAG retrieval log ────────────────────────────────────
  console.log('\n── RAG LOG ────────────────────────────────────────────────\n');
  const { rows: logRows } = await pool.query(
    `SELECT id, LEFT(query_text, 60) AS query, chunks_returned, layers_hit,
            ROUND(top_score::numeric, 3) AS top_score, duration_ms
     FROM rag_retrieval_log WHERE property_id = $1 ORDER BY created_at DESC LIMIT 3`,
    [property.id]
  );
  if (logRows.length > 0) {
    console.log('Recent RAG retrievals for this property:');
    for (const r of logRows) {
      console.log(`  #${r.id}: ${r.chunks_returned} chunks, top=${r.top_score}, ${r.duration_ms}ms — "${r.query}"`);
      console.log(`         layers: ${(r.layers_hit || []).join(', ')}`);
    }
  } else {
    console.log('No RAG retrievals logged for this property.');
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  TEST COMPLETE');
  console.log('═══════════════════════════════════════════════════════════\n');
}

run()
  .then(() => pool.end())
  .catch(err => { console.error(err); pool.end(); process.exit(1); });
