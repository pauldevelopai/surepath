/**
 * Daily video factory.
 * Produces N videos per run (default 4), fully automated:
 *
 *  1. Find unused insights (WhatsApp teases with properties) that haven't been made into videos.
 *  2. If insufficient, fall back to problematic properties (CRITICAL/HIGH vision findings, not yet used).
 *  3. For each picked subject: generate script → audio → free captions → compose video.
 *  4. Store in content_posts as drafts. Human reviews on /admin/videos and posts when happy.
 *
 * Runs via PM2 cron. Does NOT auto-post — posting is manual.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const pool = require('../db');
const { generateVoice } = require('../voice.js');
const { generateCaptions } = require('../captions.js');
const { buildShotList } = require('../visuals.js');
const { composeVideo } = require('../compose.js');
const { execSync } = require('child_process');
const path = require('path');

const TARGET_COUNT = parseInt(process.env.DAILY_VIDEO_COUNT || '4');

async function findWhatsAppTeases() {
  const { rows } = await pool.query(`
    SELECT c.tease_data, c.listing_url, p.id AS property_id, p.address_raw, p.asking_price
    FROM conversations c
    LEFT JOIN properties p ON p.listing_url = c.listing_url
    WHERE c.tease_data IS NOT NULL
      AND p.id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM content_posts cp WHERE cp.property_id = p.id
      )
    ORDER BY c.updated_at DESC LIMIT 20
  `);
  return rows.map((r) => {
    const t = typeof r.tease_data === 'string' ? JSON.parse(r.tease_data) : r.tease_data;
    return {
      source: 'whatsapp',
      propertyId: r.property_id,
      address: t.address || r.address_raw,
      askingPrice: t.askingPrice || r.asking_price,
      bedrooms: t.bedrooms,
      bathrooms: t.bathrooms,
      nicoTease: t.nicoTease,
      topRiskFlags: t.topRiskFlags || [],
    };
  }).filter((i) => i.nicoTease);
}

async function findProblematicProperties(excludePropertyIds = []) {
  const exclude = excludePropertyIds.length > 0 ? excludePropertyIds : [0];
  const { rows: props } = await pool.query(`
    SELECT p.id, p.address_raw, p.address_normalised, p.asking_price, p.bedrooms, p.bathrooms
    FROM properties p
    WHERE EXISTS (
      SELECT 1 FROM property_images pi
      WHERE pi.property_id = p.id AND pi.vision_analysis IS NOT NULL
    )
    AND NOT EXISTS (SELECT 1 FROM content_posts cp WHERE cp.property_id = p.id)
    AND p.id <> ALL($1::int[])
    ORDER BY p.id DESC LIMIT 50
  `, [exclude]);

  const results = [];
  for (const p of props) {
    const { rows: imgs } = await pool.query(
      "SELECT vision_analysis FROM property_images WHERE property_id = $1 AND vision_analysis IS NOT NULL LIMIT 8",
      [p.id]
    );
    const flags = [];
    let criticalCount = 0;
    for (const img of imgs) {
      const va = typeof img.vision_analysis === 'string' ? JSON.parse(img.vision_analysis) : img.vision_analysis;
      for (const f of (va?.findings || [])) {
        if ((f.severity === 'CRITICAL' || f.severity === 'HIGH') && f.observation) {
          flags.push(f.observation);
          if (f.severity === 'CRITICAL') criticalCount++;
        }
      }
    }
    if (flags.length >= 1) {
      results.push({
        source: 'vision_fallback',
        propertyId: p.id,
        address: p.address_normalised || p.address_raw,
        askingPrice: p.asking_price,
        bedrooms: p.bedrooms,
        bathrooms: p.bathrooms,
        nicoTease: null,
        topRiskFlags: flags.slice(0, 5),
        criticalCount,
      });
    }
  }
  // Prioritise properties with the most critical findings
  results.sort((a, b) => b.criticalCount - a.criticalCount);
  return results;
}

/**
 * Last-resort fallback — any property with photos that hasn't had a video.
 * Used when we've exhausted teases AND problematic properties.
 * Script built on address + price only (no vision flags needed).
 */
async function findAnyPropertiesWithPhotos(excludePropertyIds = [], limit = 20) {
  const exclude = excludePropertyIds.length > 0 ? excludePropertyIds : [0];
  const { rows } = await pool.query(`
    SELECT p.id, p.address_raw, p.address_normalised, p.asking_price, p.bedrooms, p.bathrooms, p.suburb
    FROM properties p
    WHERE EXISTS (
      SELECT 1 FROM property_images pi
      WHERE pi.property_id = p.id AND pi.source IN ('property24','privateproperty')
    )
    AND NOT EXISTS (SELECT 1 FROM content_posts cp WHERE cp.property_id = p.id)
    AND p.id <> ALL($1::int[])
    AND p.asking_price IS NOT NULL
    ORDER BY p.created_at DESC LIMIT $2
  `, [exclude, limit]);

  return rows.map((p) => ({
    source: 'random_fallback',
    propertyId: p.id,
    address: p.address_normalised || p.address_raw,
    askingPrice: p.asking_price,
    bedrooms: p.bedrooms,
    bathrooms: p.bathrooms,
    suburb: p.suburb,
    nicoTease: null,
    topRiskFlags: [],
  }));
}

async function generateScript(insight) {
  const Anthropic = require('@anthropic-ai/sdk').default;
  const { retrieve, formatForPrompt } = require('../rag.js');
  const client = new Anthropic();

  const query = `${insight.address || ''} ${insight.topRiskFlags?.[0] || ''} ${insight.nicoTease || ''}`;
  const chunks = await retrieve(query, { topK: 8, minScore: 0.4 });
  const ragContext = chunks.length > 0
    ? `\n\nREAL KNOWLEDGE BASE:\n${formatForPrompt(chunks)}` : '';

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: `You are Nico — South African ex-property agent. Make 10-second viral Reels.

CURRENCY RULE: Never write "R" as prefix. Spell amounts as words (e.g. "five hundred and eighty thousand rand"). Use "rand" singular.

NO FABRICATION: Do NOT invent numbers, timeframes, or stats. Only use the asking price from the insight and any cost ranges from the knowledge base. Speak in plain stakes: "thousands in repairs", "your whole deposit", "a debt bomb".

Surepath = the insider who reveals hidden property secrets nobody else will tell you.

Script flows as one continuous spoken piece:
- Opens with a SALACIOUS attack/claim (4-6 words)
- Middle: specific punch + stakes (10-14 words)
- Ends with tactical advice + Surepath as insider (7-10 words)
- Total 22-28 words — must read aloud in ~10 seconds.

Return JSON: { "script": "the full spoken script" }`,
    messages: [{
      role: 'user',
      content: `Create a 10-second viral reel script about this property:

Property: ${insight.address}
Price: ${insight.askingPrice ? `R${Number(insight.askingPrice).toLocaleString()}` : 'unknown'}
${insight.bedrooms ? `${insight.bedrooms} bed, ${insight.bathrooms || '?'} bath` : ''}
${insight.nicoTease ? `Nico's take: ${insight.nicoTease}` : ''}
Risk flags:
${(insight.topRiskFlags || []).map((f) => `- ${f}`).join('\n')}${ragContext}

Return JSON only.`,
    }],
  });

  let text = msg.content[0].type === 'text' ? msg.content[0].text : '';
  if (text.startsWith('```')) text = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  const parsed = JSON.parse(text);
  return parsed.script;
}

async function produceOneVideo(insight) {
  console.log(`\n=== Producing video for: ${insight.address} (source=${insight.source}) ===`);

  // 1. Script
  const script = await generateScript(insight);
  console.log(`  Script (${script.split(/\s+/).length} words): ${script}`);

  // 2. Save draft
  const firstSentence = (script.split(/[.!?]/)[0] || '').trim();
  const lastSentence = (script.split(/[.!?]/).filter(Boolean).pop() || '').trim();
  const { rows: postRows } = await pool.query(
    `INSERT INTO content_posts (pillar, hook, script, cta, status, property_id)
     VALUES ($1, $2, $3, $4, 'draft', $5) RETURNING id`,
    ['inspection_reveal', firstSentence, script, lastSentence, insight.propertyId]
  );
  const postId = postRows[0].id;
  console.log(`  Post ID: ${postId}`);

  // 3. Audio via ElevenLabs
  const audioUrl = await generateVoice(script, undefined, postId);
  console.log(`  Audio: ${audioUrl}`);

  // 4. Probe duration with ffprobe
  const relPath = audioUrl.split('/content/')[1];
  const localAudio = path.resolve(__dirname, '..', 'dashboard', 'public', 'content', relPath);
  const probe = execSync(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${localAudio}"`, { encoding: 'utf8' }).trim();
  const durationSec = parseFloat(probe) || 10;

  // 5. Captions (free, from script text)
  const srtContent = generateCaptions(script, durationSec);
  await pool.query('UPDATE content_posts SET srt_content = $1 WHERE id = $2', [srtContent, postId]);

  // 6. Shot list + compose
  const shotList = await buildShotList(script, durationSec, insight.propertyId);
  const outputName = `nico-reel-${postId}-${Date.now()}`;
  const finalUrl = await composeVideo(audioUrl, srtContent, insight.propertyId, firstSentence, outputName, postId, shotList);
  console.log(`  DONE: ${finalUrl}`);

  return { postId, finalUrl };
}

async function run() {
  console.log(`\n[daily-videos] Target: ${TARGET_COUNT} videos\n`);

  // Find candidates — teases first, then problematic properties
  let candidates = await findWhatsAppTeases();
  console.log(`[daily-videos] Unused WhatsApp teases: ${candidates.length}`);

  if (candidates.length < TARGET_COUNT) {
    const usedIds = candidates.map((c) => c.propertyId);
    const fallback = await findProblematicProperties(usedIds);
    console.log(`[daily-videos] Fallback problematic properties: ${fallback.length}`);
    candidates = [...candidates, ...fallback];
  }

  if (candidates.length < TARGET_COUNT) {
    const usedIds = candidates.map((c) => c.propertyId);
    const generic = await findAnyPropertiesWithPhotos(usedIds, TARGET_COUNT - candidates.length + 5);
    console.log(`[daily-videos] Last-resort properties with photos: ${generic.length}`);
    candidates = [...candidates, ...generic];
  }

  if (candidates.length === 0) {
    console.log('[daily-videos] No candidates — nothing to produce.');
    process.exit(0);
  }

  const chosen = candidates.slice(0, TARGET_COUNT);
  console.log(`[daily-videos] Producing ${chosen.length} videos...`);

  const results = [];
  for (const c of chosen) {
    try {
      const r = await produceOneVideo(c);
      results.push({ ok: true, ...r, address: c.address });
    } catch (e) {
      console.error(`[daily-videos] Failed for ${c.address}: ${e.message}`);
      results.push({ ok: false, address: c.address, error: e.message });
    }
  }

  const ok = results.filter((r) => r.ok).length;
  console.log(`\n[daily-videos] DONE. ${ok}/${chosen.length} videos produced.`);
  for (const r of results) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.address}${r.finalUrl ? ' → ' + r.finalUrl : ''}${r.error ? ' (' + r.error + ')' : ''}`);
  }

  process.exit(0);
}

run().catch((e) => {
  console.error('[daily-videos] FATAL:', e);
  process.exit(1);
});
