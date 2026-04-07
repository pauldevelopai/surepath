/**
 * Test Nico + RAG on a single photo file.
 * Usage: node test-photo.js /path/to/image.jpeg [suburb] [city]
 */
require('dotenv').config();
const fs = require('fs');
const pool = require('./db');
const Anthropic = require('@anthropic-ai/sdk');
const { getNicoPrompt } = require('./vision');
const { retrieve } = require('./rag');

const imagePath = process.argv[2] || '/tmp/test-house.jpeg';
const suburb = process.argv[3] || null;
const city = process.argv[4] || null;

(async () => {
  const imgBuf = fs.readFileSync(imagePath);
  console.log(`\nImage: ${imagePath} (${imgBuf.length} bytes)\n`);

  // RAG retrieval
  console.log('── RAG RETRIEVAL ──────────────────────────────────────────\n');
  const queryParts = [];
  if (suburb) queryParts.push(suburb);
  if (city) queryParts.push(city);
  queryParts.push('residential house, exterior photo, walls, roof, South African property defects and risks');
  const queryText = queryParts.join(', ');
  console.log(`Query: "${queryText}"\n`);

  const chunks = await retrieve(queryText, { topK: 20, suburb, minScore: 0.35 });
  console.log(`Retrieved ${chunks.length} chunks\n`);

  const byLayer = {};
  for (const c of chunks) { if (!byLayer[c.layer]) byLayer[c.layer] = []; byLayer[c.layer].push(c); }
  for (const [layer, lc] of Object.entries(byLayer)) {
    console.log(`  [${layer}] ${lc.length} chunks — top: ${Number(lc[0].score).toFixed(3)}`);
    for (const c of lc) console.log(`    ${Number(c.score).toFixed(3)} — ${c.text.substring(0, 80).replace(/\n/g, ' ')}...`);
  }

  // Build Nico prompt
  console.log('\n── NICO PROMPT ────────────────────────────────────────────\n');
  const propertyContext = suburb ? { suburb, city } : null;
  const prompt = await getNicoPrompt(propertyContext);
  console.log(`Prompt: ${prompt.length} chars\n`);

  // Send to Claude
  console.log('── CLAUDE VISION ──────────────────────────────────────────\n');
  console.log('Sending to Claude...');
  const client = new Anthropic();
  const start = Date.now();
  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    system: prompt,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imgBuf.toString('base64') } },
      { type: 'text', text: 'Analyse this property photo.' }
    ]}],
  });
  const elapsed = Date.now() - start;
  const response = msg.content[0].type === 'text' ? msg.content[0].text : '';
  console.log(`Responded in ${elapsed}ms (${msg.usage.input_tokens} in, ${msg.usage.output_tokens} out)\n`);

  // Parse
  let json = response;
  if (json.includes('```')) json = json.replace(/```(?:json)?\s*/g, '').replace(/```/g, '');
  try {
    const parsed = JSON.parse(json);
    const findings = parsed.findings || [];
    console.log(`Photo type: ${parsed.photo_type || '?'}`);
    console.log(`Roof: ${parsed.roof_material || '?'}`);
    console.log(`Asbestos: ${parsed.asbestos_indicators || false}`);
    console.log(`Security: ${parsed.security_visible || false}`);
    console.log(`Findings: ${findings.length}\n`);

    for (let i = 0; i < findings.length; i++) {
      const f = findings[i];
      console.log(`  Finding ${i + 1}: [${f.category}] ${f.severity}`);
      console.log(`    See:    ${(f.what_i_see || '').substring(0, 140)}`);
      console.log(`    Defect: ${f.defect_or_risk || 'none'}`);
      if (f.kb_entry_matched) console.log(`    KB:     ${f.kb_entry_matched} — ${f.kb_match_reason || ''}`);
      console.log(`    SA:     ${(f.sa_context || '').substring(0, 120)}`);
      console.log(`    Tier:   ${f.confidence_tier} — ${(f.tier_reason || '').substring(0, 100)}`);
      console.log(`    Means:  ${(f.what_it_means || '').substring(0, 200)}`);
      if (f.estimated_repair_cost_zar?.min) console.log(`    Cost:   R${f.estimated_repair_cost_zar.min}–R${f.estimated_repair_cost_zar.max}`);
      console.log('');
    }
  } catch (e) {
    console.log('Parse error: ' + e.message);
    console.log(response.substring(0, 2000));
  }

  await pool.end();
})();
