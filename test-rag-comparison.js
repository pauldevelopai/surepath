/**
 * Compare RAG vs no-RAG across multiple properties.
 * Shows measurable differences in findings, cost estimates, KB references, and specificity.
 *
 * Usage: node test-rag-comparison.js
 */
require('dotenv').config();
const fs = require('fs');
const pool = require('./db');
const Anthropic = require('@anthropic-ai/sdk');
const { getNicoPrompt } = require('./vision');

const visionSrc = fs.readFileSync(__dirname + '/vision.js', 'utf8');
const match = visionSrc.match(/const NICO_SYSTEM_PROMPT = `([\s\S]*?)`;/);
const BASE_PROMPT = match ? match[1] : '';

const client = new Anthropic();

async function analysePhoto(imageUrl, systemPrompt) {
  const { downloadImage, detectMediaType } = require('./vision');
  const buffer = await downloadImage(imageUrl);
  const mediaType = detectMediaType(imageUrl, buffer);

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: mediaType, data: buffer.toString('base64') } },
      { type: 'text', text: 'Analyse this property photo.' },
    ]}],
  });

  const text = msg.content[0].type === 'text' ? msg.content[0].text : '';
  let json = text;
  if (json.includes('```')) json = json.replace(/```(?:json)?\s*/g, '').replace(/```/g, '');
  try {
    const parsed = JSON.parse(json);
    return { findings: parsed.findings || [], tokens_in: msg.usage.input_tokens, tokens_out: msg.usage.output_tokens };
  } catch {
    return { findings: [], tokens_in: msg.usage.input_tokens, tokens_out: msg.usage.output_tokens, parse_error: true };
  }
}

function scoreFinding(f) {
  let score = 0;
  if (f.kb_entry_matched) score += 3;
  if (f.estimated_repair_cost_zar?.min > 0) score += 2;
  if (f.sa_context && f.sa_context.length > 50) score += 1;
  if (f.corroboration?.data_used?.length > 1) score += 1;
  if (f.confidence_tier >= 2) score += 2;
  if (f.needs_inspection && f.needs_inspection.length > 30) score += 1;
  return score;
}

(async () => {
  const { rows: testProps } = await pool.query(`
    SELECT p.id, p.suburb, p.city, p.roof_material, p.construction_era, pi.image_url
    FROM properties p
    JOIN property_images pi ON pi.property_id = p.id
    WHERE pi.vision_analysis IS NOT NULL AND pi.image_url LIKE 'https%' AND p.suburb IS NOT NULL
    ORDER BY RANDOM() LIMIT 3
  `);

  console.log(`\n${'='.repeat(70)}`);
  console.log('  RAG vs NO-RAG COMPARISON — ' + testProps.length + ' properties');
  console.log('='.repeat(70));

  const totals = { noRag: { findings: 0, costs: 0, kb: 0, score: 0 }, rag: { findings: 0, costs: 0, kb: 0, score: 0 } };

  for (const prop of testProps) {
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`Property #${prop.id}: ${prop.suburb}, ${prop.city} (${prop.roof_material || '?'} roof)`);
    console.log(`Image: ${prop.image_url.substring(0, 60)}...`);

    // Build RAG prompt
    const propertyContext = { suburb: prop.suburb, city: prop.city, roof_material: prop.roof_material, construction_era: prop.construction_era, propertyId: prop.id };
    const ragPrompt = await getNicoPrompt(propertyContext);

    console.log(`\nBase prompt: ${BASE_PROMPT.length} chars`);
    console.log(`RAG prompt:  ${ragPrompt.length} chars (+${ragPrompt.length - BASE_PROMPT.length} from RAG)\n`);

    // Run both
    console.log('Running without RAG...');
    const noRag = await analysePhoto(prop.image_url, BASE_PROMPT);
    console.log('Running with RAG...');
    const withRag = await analysePhoto(prop.image_url, ragPrompt);

    // Compare
    const noRagCosts = noRag.findings.filter(f => f.estimated_repair_cost_zar?.min > 0).length;
    const ragCosts = withRag.findings.filter(f => f.estimated_repair_cost_zar?.min > 0).length;
    const noRagKb = noRag.findings.filter(f => f.kb_entry_matched).length;
    const ragKb = withRag.findings.filter(f => f.kb_entry_matched).length;
    const noRagScore = noRag.findings.reduce((s, f) => s + scoreFinding(f), 0);
    const ragScore = withRag.findings.reduce((s, f) => s + scoreFinding(f), 0);

    console.log(`\n  ${''.padEnd(25)} WITHOUT RAG    WITH RAG`);
    console.log(`  ${'Findings'.padEnd(25)} ${String(noRag.findings.length).padStart(8)}    ${String(withRag.findings.length).padStart(8)}`);
    console.log(`  ${'With cost estimates'.padEnd(25)} ${String(noRagCosts).padStart(8)}    ${String(ragCosts).padStart(8)}`);
    console.log(`  ${'KB entries matched'.padEnd(25)} ${String(noRagKb).padStart(8)}    ${String(ragKb).padStart(8)}`);
    console.log(`  ${'Quality score'.padEnd(25)} ${String(noRagScore).padStart(8)}    ${String(ragScore).padStart(8)}`);
    console.log(`  ${'Tokens (in/out)'.padEnd(25)} ${(noRag.tokens_in + '/' + noRag.tokens_out).padStart(8)}    ${(withRag.tokens_in + '/' + withRag.tokens_out).padStart(8)}`);

    totals.noRag.findings += noRag.findings.length;
    totals.noRag.costs += noRagCosts;
    totals.noRag.kb += noRagKb;
    totals.noRag.score += noRagScore;
    totals.rag.findings += withRag.findings.length;
    totals.rag.costs += ragCosts;
    totals.rag.kb += ragKb;
    totals.rag.score += ragScore;
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log('  TOTALS ACROSS ALL PROPERTIES');
  console.log('='.repeat(70));
  console.log(`  ${''.padEnd(25)} WITHOUT RAG    WITH RAG    DIFF`);
  console.log(`  ${'Findings'.padEnd(25)} ${String(totals.noRag.findings).padStart(8)}    ${String(totals.rag.findings).padStart(8)}    ${totals.rag.findings - totals.noRag.findings >= 0 ? '+' : ''}${totals.rag.findings - totals.noRag.findings}`);
  console.log(`  ${'With cost estimates'.padEnd(25)} ${String(totals.noRag.costs).padStart(8)}    ${String(totals.rag.costs).padStart(8)}    ${totals.rag.costs - totals.noRag.costs >= 0 ? '+' : ''}${totals.rag.costs - totals.noRag.costs}`);
  console.log(`  ${'KB entries matched'.padEnd(25)} ${String(totals.noRag.kb).padStart(8)}    ${String(totals.rag.kb).padStart(8)}    ${totals.rag.kb - totals.noRag.kb >= 0 ? '+' : ''}${totals.rag.kb - totals.noRag.kb}`);
  console.log(`  ${'Quality score'.padEnd(25)} ${String(totals.noRag.score).padStart(8)}    ${String(totals.rag.score).padStart(8)}    ${totals.rag.score - totals.noRag.score >= 0 ? '+' : ''}${totals.rag.score - totals.noRag.score}`);
  console.log('');

  await pool.end();
})();
