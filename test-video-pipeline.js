/**
 * End-to-end test of the video factory pipeline.
 * Generates a full Nico reel from a real WhatsApp tease.
 */
require('dotenv').config();

const pool = require('./db');
const { generateVoice, estimateDuration } = require('./voice.js');
const { generateCaptions } = require('./captions.js');
const { buildShotList } = require('./visuals.js');
const { composeVideo } = require('./compose.js');

// Use the Durban CBD apartment tease — property 4685, 9 photos
const PROPERTY_ID = 4685;

async function run() {
  console.log('\n=== NICO REEL PIPELINE TEST ===\n');

  // Step 1: Load the tease from conversation
  const { rows: convRows } = await pool.query(`
    SELECT c.tease_data
    FROM conversations c
    LEFT JOIN properties p ON p.listing_url = c.listing_url
    WHERE p.id = $1 AND c.tease_data IS NOT NULL
    LIMIT 1
  `, [PROPERTY_ID]);

  if (!convRows[0]) { console.error('No tease found'); process.exit(1); }
  const tease = typeof convRows[0].tease_data === 'string'
    ? JSON.parse(convRows[0].tease_data) : convRows[0].tease_data;

  console.log(`Tease: ${tease.address} — R${tease.askingPrice}`);
  console.log(`Nico's take: ${tease.nicoTease}`);
  console.log(`Risk flags: ${tease.topRiskFlags?.length || 0}\n`);

  // Step 2: Generate script with Claude + RAG
  console.log('[1/5] Generating script with Claude + RAG...');
  const { retrieve, formatForPrompt } = require('./rag.js');
  const Anthropic = require('@anthropic-ai/sdk').default;
  const client = new Anthropic();

  const query = `${tease.address} ${tease.topRiskFlags?.[0] || ''} ${tease.nicoTease}`;
  const chunks = await retrieve(query, { topK: 8, minScore: 0.4 });
  const ragContext = chunks.length > 0
    ? `\n\nREAL KNOWLEDGE BASE:\n${formatForPrompt(chunks)}` : '';

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: `You are Nico — South African ex-property agent. Make 10-second viral Reels.

ZERO FABRICATION: Do NOT invent numbers, timeframes, or stats. Only use the asking price from the insight and any cost ranges from the knowledge base. Speak in plain stakes: "thousands in repairs", "your whole deposit", "a debt bomb".

Surepath = the insider who reveals hidden property secrets nobody else will tell you.

Structure — 22-28 words TOTAL across 3 fields, no repetition:
- hook (4-6 words): SALACIOUS attack. "Your agent is hiding this." NOT descriptive.
- script (10-14 words): specific punch + stakes
- cta (7-10 words): real tactical advice + Surepath as the insider

Return JSON: { "hook": "...", "script": "...", "cta": "..." }`,
    messages: [{
      role: 'user',
      content: `Create an inspection_reveal 10-second reel about: ${tease.address}

Property: ${tease.address}
Price: R${Number(tease.askingPrice).toLocaleString()}
Nico's take: ${tease.nicoTease}
Risk flags:
${(tease.topRiskFlags || []).map((f) => `- ${f}`).join('\n')}${ragContext}

Return JSON only.`,
    }],
  });

  let text = msg.content[0].type === 'text' ? msg.content[0].text : '';
  if (text.startsWith('```')) text = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  const parsed = JSON.parse(text);

  console.log(`  Hook:   ${parsed.hook}`);
  console.log(`  Script: ${parsed.script}`);
  console.log(`  CTA:    ${parsed.cta}\n`);

  // Store content post
  const { rows: postRows } = await pool.query(
    `INSERT INTO content_posts (pillar, hook, script, cta, status, property_id)
     VALUES ('inspection_reveal', $1, $2, $3, 'draft', $4) RETURNING id`,
    [parsed.hook, parsed.script, parsed.cta, PROPERTY_ID]
  );
  const postId = postRows[0].id;
  console.log(`  Post ID: ${postId}\n`);

  // Step 3: Generate audio
  console.log('[2/5] Generating ElevenLabs audio...');
  const fullScript = [parsed.hook, parsed.script, parsed.cta].filter(Boolean).join(' ');
  console.log(`  Text: ${fullScript}`);
  console.log(`  Words: ${fullScript.split(/\s+/).length}`);
  const audioUrl = await generateVoice(fullScript, undefined, postId);
  console.log(`  Audio: ${audioUrl}\n`);

  // Step 4: Generate captions — probe real duration with ffprobe
  console.log('[3/5] Generating captions...');
  const { execSync } = require('child_process');
  const path = require('path');
  const relPath = audioUrl.split('/content/')[1];
  const localAudio = path.resolve(__dirname, 'dashboard', 'public', 'content', relPath);
  const probe = execSync(
    `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${localAudio}"`,
    { encoding: 'utf8' }
  ).trim();
  const durationSec = parseFloat(probe) || 10;
  console.log(`  Audio duration (ffprobe): ${durationSec.toFixed(1)}s`);

  const srtContent = generateCaptions(fullScript, durationSec);
  await pool.query('UPDATE content_posts SET srt_content = $1 WHERE id = $2', [srtContent, postId]);
  console.log(`  SRT: ${srtContent.split('\n\n').length - 1} lines\n`);

  // Step 5: Build shot list
  console.log('[4/5] Building shot list with visual matcher...');
  const shotList = await buildShotList(fullScript, durationSec, PROPERTY_ID);
  console.log(`  Shots: ${shotList.length}`);
  shotList.forEach((s, i) => {
    const secs = `${(s.startMs / 1000).toFixed(1)}-${(s.endMs / 1000).toFixed(1)}s`;
    console.log(`    ${i+1}. [${s.type}] ${secs} — ${s.description?.substring(0, 80) || ''}`);
  });
  console.log('');

  // Step 6: Compose final video
  console.log('[5/5] Composing final video with FFmpeg...');
  const outputName = `nico-test-${postId}-${Date.now()}`;
  const finalUrl = await composeVideo(
    audioUrl, srtContent, PROPERTY_ID, parsed.hook, outputName, postId, shotList
  );

  console.log('\n=== DONE ===');
  console.log(`Final video: ${finalUrl}`);

  await pool.end();
  process.exit(0);
}

run().catch((e) => {
  console.error('\n[FATAL]', e);
  process.exit(1);
});
