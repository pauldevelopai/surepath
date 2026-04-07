/**
 * Test Nico WITHOUT RAG — just the base system prompt, no context.
 * Usage: node test-photo-no-rag.js /path/to/image.jpeg
 */
require('dotenv').config();
const fs = require('fs');
const pool = require('./db');
const Anthropic = require('@anthropic-ai/sdk');

const imagePath = process.argv[2] || '/tmp/test-house.jpeg';

// Read the base Nico prompt from vision.js source
const visionSrc = fs.readFileSync(__dirname + '/vision.js', 'utf8');
const match = visionSrc.match(/const NICO_SYSTEM_PROMPT = `([\s\S]*?)`;/);
const basePrompt = match ? match[1] : '';

(async () => {
  const imgBuf = fs.readFileSync(imagePath);
  console.log(`\nImage: ${imagePath} (${imgBuf.length} bytes)`);
  console.log(`Prompt: ${basePrompt.length} chars (BASE ONLY — no RAG, no context)\n`);

  console.log('Sending to Claude...');
  const client = new Anthropic();
  const start = Date.now();
  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    system: basePrompt,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imgBuf.toString('base64') } },
      { type: 'text', text: 'Analyse this property photo.' }
    ]}],
  });
  const elapsed = Date.now() - start;
  const response = msg.content[0].type === 'text' ? msg.content[0].text : '';
  console.log(`Responded in ${elapsed}ms (${msg.usage.input_tokens} in, ${msg.usage.output_tokens} out)\n`);

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
      if (f.kb_entry_matched) console.log(`    KB:     ${f.kb_entry_matched}`);
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
