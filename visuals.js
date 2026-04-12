/**
 * AI visual matcher — takes a script + audio duration, returns a timed shot list.
 *
 * Strategy:
 * 1. Use Claude to break the script into 3-5 visual "beats" with descriptions of
 *    what should be shown on screen for each.
 * 2. For each beat, first check if there's a matching property photo (if propertyId given).
 * 3. Fall back to best-matching stock footage from our library.
 * 4. Distribute beats evenly across the audio duration.
 *
 * Returns: [{ startMs, endMs, type: 'photo'|'stock', url, description }]
 */

const pool = require('./db');

const STOCK_CATEGORIES = [
  'exterior', 'interior', 'defect', 'system', 'finance', 'safety', 'emotion', 'abstract',
];

/**
 * Use Claude to break a script into visual beats.
 * Each beat is a phrase + a target category/keyword for the visual.
 */
async function planShots(fullScript, numBeats = 4) {
  const Anthropic = require('@anthropic-ai/sdk').default;
  const client = new Anthropic();

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: `You are a video director planning visuals for a 10-second vertical property-advice reel.
The script is about a SPECIFIC REAL PROPERTY and we have actual photos of it.

STRATEGY: Show the REAL property as much as possible. Stock footage is a fallback for abstract/emotional beats only.

Given a short script, break it into ${numBeats} sequential visual beats. For each beat, return:
- text: the exact portion of the script said during this beat
- category: ONE of ${STOCK_CATEGORIES.join(', ')}
- keyword: a short 2-4 word visual query to find stock footage (e.g. "water damage ceiling", "signing contract", "empty kitchen")
- prefer_property_photo: DEFAULT TO TRUE. Only set false if the beat is purely abstract (money falling, red flags, signing contracts) or emotional (stressed face). Property descriptions, defects mentioned, locations, interiors — always use the real property photos.

Your categories mapped:
- exterior: house exteriors, apartment buildings, streets
- interior: kitchens, bathrooms, bedrooms, living rooms
- defect: water damage, cracks, mould, rust, leaks
- system: DB boards, geysers, solar panels, aircon
- finance: money, contracts, keys, signatures, calculators
- safety: security cameras, burglar bars, fences, night streets
- emotion: faces showing worry, shock, stress, regret, joy
- abstract: red flags, warning signs, magnifying glass on documents, falling money

Return JSON: { "beats": [{ "text": "...", "category": "...", "keyword": "...", "prefer_property_photo": true|false }] }`,
    messages: [{
      role: 'user',
      content: `Script: "${fullScript}"\n\nBreak into ${numBeats} visual beats. Return JSON only.`,
    }],
  });

  let text = message.content[0].type === 'text' ? message.content[0].text : '';
  if (text.startsWith('```')) text = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  const parsed = JSON.parse(text);
  return parsed.beats || [];
}

/**
 * Get property photos with their vision analysis for semantic matching.
 */
async function getPropertyPhotos(propertyId, limit = 25) {
  if (!propertyId) return [];
  // Listing photos first, then streetview + satellite as additional exterior options
  const { rows } = await pool.query(
    `SELECT id, image_url, image_type, vision_analysis, source FROM property_images
     WHERE property_id = $1 AND source IN ('property24','privateproperty','streetview','satellite')
     ORDER BY CASE source
       WHEN 'property24' THEN 1
       WHEN 'privateproperty' THEN 1
       WHEN 'streetview' THEN 2
       WHEN 'satellite' THEN 3
     END, id LIMIT $2`,
    [propertyId, limit]
  );

  // Build a short description from vision_analysis for semantic matching
  return rows.map((r) => {
    const va = typeof r.vision_analysis === 'string' ? JSON.parse(r.vision_analysis) : r.vision_analysis;
    const bits = [];
    if (r.source === 'streetview') bits.push('Street view — exterior of the property from the street');
    else if (r.source === 'satellite') bits.push('Satellite view — aerial view of the property');
    else if (r.image_type) bits.push(r.image_type);
    if (va?.scene) bits.push(va.scene);
    if (va?.room_type) bits.push(va.room_type);
    if (va?.findings?.length) {
      bits.push(va.findings.slice(0, 2).map((f) => f.observation || f.defect || '').filter(Boolean).join('; '));
    }
    return {
      id: r.id,
      url: r.image_url,
      description: bits.filter(Boolean).join(' — ') || 'property photo',
    };
  });
}

/**
 * Use Claude to pick the best photo for each beat based on photo descriptions.
 * Returns a map of beatIndex → photoId (or null if no good match).
 */
async function matchPhotosToBeats(beats, photos) {
  if (photos.length === 0 || beats.length === 0) return new Map();

  const Anthropic = require('@anthropic-ai/sdk').default;
  const client = new Anthropic();

  const photoList = photos.map((p, i) => `${i}: ${p.description}`).join('\n');
  const beatList = beats.map((b, i) => `${i}: "${b.text}" (wants: ${b.category}/${b.keyword})`).join('\n');

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    system: `You match property photos to video beats for a social-media reel about THIS SPECIFIC PROPERTY.

THE RULE: SHOW THE PROPERTY AS MUCH AS POSSIBLE. This video is about THIS property — the viewer should see THIS property on screen almost the entire time. Stock footage is the rare exception, not the rule.

RULES:
- Each photo can only be used ONCE across all beats (no repeats).
- ASSUME YOU'LL USE A PHOTO FOR EVERY BEAT. Start with that assumption, then only override if the beat is impossibly abstract.
- You MUST return a photoIndex for at least ${Math.max(beats.length - 1, 1)} of the ${beats.length} beats. The LAST beat (the CTA) is the only one where stock may be appropriate.
- Property photos are valid for ANY beat mentioning: the property, the area, the building, the floor, levies, damp, construction, rooms, layout, safety, location, views, anything physical. That's 95% of beats.
- ONLY return null if the beat is PURELY an abstract financial/emotional moment (e.g. "signing a contract", "holding a pile of cash", "red flags everywhere") — AND there is truly no property photo that could fit.
- Generic exterior/lobby photos ARE useful — use them for beats about "this building", "this property", "this area".
- Street view and satellite views count as valid property photos too.

Return JSON: { "matches": [{ "beatIndex": 0, "photoIndex": 2 }, ...] }`,
    messages: [{
      role: 'user',
      content: `Photos:\n${photoList}\n\nBeats:\n${beatList}\n\nMatch each beat to its best photo (or null if none fit). Return JSON only.`,
    }],
  });

  let text = message.content[0].type === 'text' ? message.content[0].text : '';
  if (text.startsWith('```')) text = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  const parsed = JSON.parse(text);

  const map = new Map();
  const usedPhotos = new Set();
  for (const m of (parsed.matches || [])) {
    if (m.photoIndex != null && !usedPhotos.has(m.photoIndex) && photos[m.photoIndex]) {
      map.set(m.beatIndex, photos[m.photoIndex]);
      usedPhotos.add(m.photoIndex);
    }
  }
  return map;
}

/**
 * Find best-matching stock footage for a beat.
 * Prefers our owned library (Mixkit/Unsplash — S3-hosted) over Pexels (external URLs).
 * Within each tier: category + keyword, then category, then random unused.
 */
async function findStockFootage(category, keyword, usedIds) {
  const usedArray = usedIds.length > 0 ? usedIds : [0];

  // Tier 1 — owned library (mixkit, unsplash), category + keyword match
  let { rows } = await pool.query(
    `SELECT id, video_url, media_type, description, source FROM stock_footage
     WHERE source IN ('mixkit','unsplash')
       AND category = $1
       AND (keyword ILIKE $2 OR description ILIKE $2)
       AND id <> ALL($3::int[])
     ORDER BY fetched_at DESC LIMIT 1`,
    [category, `%${keyword}%`, usedArray]
  );
  if (rows.length > 0) return rows[0];

  // Tier 2 — owned library, category match only
  ({ rows } = await pool.query(
    `SELECT id, video_url, media_type, description, source FROM stock_footage
     WHERE source IN ('mixkit','unsplash')
       AND category = $1 AND id <> ALL($2::int[])
     ORDER BY RANDOM() LIMIT 1`,
    [category, usedArray]
  ));
  if (rows.length > 0) return rows[0];

  // Tier 3 — Pexels (external URLs), category + keyword
  ({ rows } = await pool.query(
    `SELECT id, video_url, media_type, description, source FROM stock_footage
     WHERE category = $1
       AND (keyword ILIKE $2 OR description ILIKE $2)
       AND id <> ALL($3::int[])
     ORDER BY fetched_at DESC LIMIT 1`,
    [category, `%${keyword}%`, usedArray]
  ));
  if (rows.length > 0) return rows[0];

  // Tier 4 — Pexels, category match
  ({ rows } = await pool.query(
    `SELECT id, video_url, media_type, description, source FROM stock_footage
     WHERE category = $1 AND id <> ALL($2::int[])
     ORDER BY RANDOM() LIMIT 1`,
    [category, usedArray]
  ));
  if (rows.length > 0) return rows[0];

  // Last resort — any unused
  ({ rows } = await pool.query(
    `SELECT id, video_url, media_type, description, source FROM stock_footage
     WHERE id <> ALL($1::int[])
     ORDER BY RANDOM() LIMIT 1`,
    [usedArray]
  ));

  return rows[0] || null;
}

/**
 * Build a shot list for the video.
 *
 * @param {string} fullScript - The complete spoken script
 * @param {number} durationSec - Audio duration in seconds
 * @param {number|null} propertyId - Optional property to pull photos from
 * @returns {Array<{ startMs, endMs, type, url, description }>}
 */
async function buildShotList(fullScript, durationSec, propertyId) {
  const numBeats = Math.max(3, Math.min(5, Math.round(durationSec / 2.5)));
  console.log(`[visuals] Planning ${numBeats} beats for ${durationSec}s script`);

  let beats;
  try {
    beats = await planShots(fullScript, numBeats);
  } catch (e) {
    console.error('[visuals] planShots failed, using fallback:', e.message);
    // Fallback: split script into N equal chunks, assign random categories
    const words = fullScript.split(/\s+/);
    const perBeat = Math.ceil(words.length / numBeats);
    beats = Array.from({ length: numBeats }, (_, i) => ({
      text: words.slice(i * perBeat, (i + 1) * perBeat).join(' '),
      category: STOCK_CATEGORIES[i % STOCK_CATEGORIES.length],
      keyword: '',
      prefer_property_photo: i === 0,
    }));
  }

  const propertyPhotos = await getPropertyPhotos(propertyId);
  console.log(`[visuals] Property ${propertyId || 'none'}: ${propertyPhotos.length} photos available`);

  // Semantically match photos to beats — each photo used at most once, unmatched beats get null
  let photoMatches = new Map();
  if (propertyPhotos.length > 0) {
    try {
      photoMatches = await matchPhotosToBeats(beats, propertyPhotos);
      console.log(`[visuals] Photo→beat matches: ${photoMatches.size}/${beats.length}`);
    } catch (e) {
      console.error('[visuals] Photo matching failed:', e.message);
    }
  }

  // FIRST BEAT HOOK RULE: first 0.5s must land with a bold, visual image.
  // Force the first beat to use the strongest property photo we have, not stock.
  // Ranking: exterior listing > interior listing > streetview > satellite.
  if (propertyPhotos.length > 0 && !photoMatches.has(0)) {
    const photoScore = (desc = '') => {
      const d = desc.toLowerCase();
      if (d.includes('exterior') || d.includes('street view') || d.includes('kitchen') || d.includes('living')) return 10;
      if (d.includes('interior') || d.includes('bedroom') || d.includes('bathroom')) return 8;
      if (d.includes('satellite')) return 3;
      return 6;
    };
    const usedIds = new Set([...photoMatches.values()].map((p) => p.id));
    const candidates = propertyPhotos
      .filter((p) => !usedIds.has(p.id))
      .sort((a, b) => photoScore(b.description) - photoScore(a.description));
    if (candidates[0]) {
      photoMatches.set(0, candidates[0]);
      console.log(`[visuals] Forced beat 0 → strongest photo: ${candidates[0].description.substring(0, 60)}`);
    }
  }

  const shotList = [];
  const usedStockIds = [];

  const totalMs = durationSec * 1000;
  const beatDuration = totalMs / beats.length;

  for (let i = 0; i < beats.length; i++) {
    const beat = beats[i];
    const startMs = Math.round(i * beatDuration);
    const endMs = Math.round(Math.min((i + 1) * beatDuration, totalMs));

    let shot = null;

    // Use semantically-matched property photo if one was found for this beat
    const matchedPhoto = photoMatches.get(i);
    if (matchedPhoto) {
      shot = {
        type: 'photo',
        url: matchedPhoto.url,
        description: `Property: ${matchedPhoto.description}`,
      };
    }

    // Otherwise use stock footage (video or photo from owned library, or Pexels)
    if (!shot) {
      const stock = await findStockFootage(beat.category, beat.keyword || '', usedStockIds);
      if (stock) {
        usedStockIds.push(stock.id);
        shot = {
          // photo-type stock goes through the same 'photo' path in compose
          type: stock.media_type === 'photo' ? 'photo' : 'stock',
          url: stock.video_url,
          description: `${stock.source}: ${stock.description || beat.category}`,
        };
      }
    }

    // GUARANTEED FALLBACK — never leave a beat without a shot.
    // Reuse a property photo (even if already used) rather than have a gap.
    if (!shot && propertyPhotos.length > 0) {
      const fallback = propertyPhotos[i % propertyPhotos.length];
      shot = {
        type: 'photo',
        url: fallback.url,
        description: `Property fallback: ${fallback.description}`,
      };
    }

    // Final-final fallback — pull ANY stock clip, ignore used tracking
    if (!shot) {
      const { rows } = await pool.query(
        `SELECT id, video_url, media_type, description, source FROM stock_footage
         ORDER BY RANDOM() LIMIT 1`
      );
      if (rows[0]) {
        shot = {
          type: rows[0].media_type === 'photo' ? 'photo' : 'stock',
          url: rows[0].video_url,
          description: `Final fallback: ${rows[0].source}`,
        };
      }
    }

    if (shot) {
      shotList.push({ startMs, endMs, text: beat.text, ...shot });
    } else {
      console.error(`[visuals] Beat ${i} has NO shot available — no property photos, no stock footage at all`);
    }
  }

  console.log(`[visuals] Shot list: ${shotList.length} shots (${shotList.filter(s => s.type === 'photo').length} photos, ${shotList.filter(s => s.type === 'stock').length} stock)`);
  return shotList;
}

module.exports = { buildShotList, planShots, getPropertyPhotos, findStockFootage };
