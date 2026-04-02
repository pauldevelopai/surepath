const https = require('https');
const http = require('http');
const Anthropic = require('@anthropic-ai/sdk');
const pool = require('./db');

const client = new Anthropic();

const BATCH_SIZE = 6;

const VISION_SYSTEM_PROMPT = `You are a certified property inspector with 20 years of South African experience.
Analyse these property photos. Identify every visible risk, defect, or flag
that would concern a buyer, an insurer, or a trades professional.

Return structured JSON per photo:
{
  photo_type: 'exterior|interior|roof|bathroom|kitchen|db_board|ceiling|other',
  findings: [{
    category: 'roof|walls|damp|electrical|plumbing|ceiling|structure|extension',
    observation: 'exact description of what you see',
    confidence: 'CONFIRMED_VISIBLE|PROBABLE|POSSIBLE|NOT_DETECTABLE',
    severity: 'CRITICAL|HIGH|MEDIUM|LOW|COSMETIC',
    estimated_repair_cost_zar: { min: 0, max: 0 },
    relevant_to: ['consumer','insurance','trades','solar']
  }],
  roof_material: 'corrugated_cement|IBR|concrete_tile|clay_tile|other|unknown',
  solar_installed: boolean,
  roof_orientation_estimate: 'north|south|east|west|unclear',
  asbestos_indicators: boolean,
  security_visible: boolean
}

Rules: Never confirm asbestos — flag indicators only requiring professional testing. Use SA property terminology. Cost estimates in ZAR for SA labour rates.

IMPORTANT: If system context is provided about this specific property, use it to guide your analysis. For example, if the property is pre-1977, pay extra attention to asbestos indicators. If the area has dolomite risk, look for foundation cracks that could indicate ground movement.`;

function getEnhancedPrompt() {
  const context = process.env.SUREPATH_VISION_CONTEXT;
  if (context) {
    return VISION_SYSTEM_PROMPT + `\n\nSYSTEM CONTEXT FOR THIS PROPERTY:\n${context}`;
  }
  return VISION_SYSTEM_PROMPT;
}

const STREETVIEW_PROMPT = `You are a certified property inspector with 20 years of South African experience.
Analyse this Google Street View image of a property exterior. Focus specifically on:
- Exterior condition changes vs what would be expected historically
- Wall cracking (hairline, stepped, horizontal, vertical)
- Roof condition visible from street level
- Damp staining on exterior walls
- Boundary walls and security features

Return structured JSON:
{
  "photo_type": "exterior",
  "findings": [{
    "category": "roof|walls|damp|electrical|plumbing|ceiling|structure|extension",
    "observation": "exact description of what you see",
    "confidence": "CONFIRMED_VISIBLE|PROBABLE|POSSIBLE|NOT_DETECTABLE",
    "severity": "CRITICAL|HIGH|MEDIUM|LOW|COSMETIC",
    "estimated_repair_cost_zar": { "min": 0, "max": 0 },
    "relevant_to": ["consumer","insurance","trades","solar"]
  }],
  "roof_material": "corrugated_cement|IBR|concrete_tile|clay_tile|other|unknown",
  "solar_installed": false,
  "roof_orientation_estimate": "north|south|east|west|unclear",
  "asbestos_indicators": false,
  "security_visible": false
}

Rules: Never confirm asbestos — flag indicators only. SA terminology. ZAR costs.
Return ONLY valid JSON. No markdown fences.`;

const SATELLITE_PROMPT = `You are a certified property inspector with 20 years of South African experience.
Analyse this satellite/aerial image of a property. Focus specifically on:
- Roof material classification (corrugated cement, IBR steel, concrete tiles, clay tiles)
- Solar panels visible on roof
- Outbuildings, extensions, or structures not on original plans
- Roof orientation estimate for solar viability (north-facing is ideal in SA)
- Pool, garden structures, parking

Return structured JSON:
{
  "photo_type": "roof",
  "findings": [{
    "category": "roof|structure|extension",
    "observation": "exact description of what you see",
    "confidence": "CONFIRMED_VISIBLE|PROBABLE|POSSIBLE|NOT_DETECTABLE",
    "severity": "CRITICAL|HIGH|MEDIUM|LOW|COSMETIC",
    "estimated_repair_cost_zar": { "min": 0, "max": 0 },
    "relevant_to": ["consumer","insurance","trades","solar"]
  }],
  "roof_material": "corrugated_cement|IBR|concrete_tile|clay_tile|other|unknown",
  "solar_installed": false,
  "roof_orientation_estimate": "north|south|east|west|unclear",
  "asbestos_indicators": false,
  "security_visible": false
}

Rules: Never confirm asbestos — flag indicators only. SA terminology. ZAR costs.
Return ONLY valid JSON. No markdown fences.`;

// ─── Image download ────────────────────────────────────────────────────

function downloadImage(url) {
  const mod = url.startsWith('https') ? https : http;
  const parsed = new (require('url').URL)(url);
  const options = {
    hostname: parsed.hostname,
    path: parsed.pathname + parsed.search,
    headers: { 'User-Agent': 'SurePath/1.0 PropertyIntelligence' },
  };
  return new Promise((resolve, reject) => {
    mod.get(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadImage(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => reject(new Error(`HTTP ${res.statusCode} downloading ${url}`)));
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function detectMediaType(url, buffer) {
  // Check magic bytes first
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) return 'image/jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png';
  if (buffer[0] === 0x47 && buffer[1] === 0x49) return 'image/gif';
  if (buffer[0] === 0x52 && buffer[1] === 0x49) return 'image/webp';
  // Fallback to URL extension
  const ext = url.split('?')[0].split('.').pop().toLowerCase();
  const map = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
  return map[ext] || 'image/jpeg';
}

// ─── Parse Claude response ─────────────────────────────────────────────

function parseVisionResponse(text) {
  let cleaned = text.trim();
  // Strip markdown fences
  if (cleaned.includes('```')) {
    cleaned = cleaned.replace(/```(?:json)?\s*/g, '').replace(/```/g, '');
  }
  // Strip any prose before the JSON — find the first { or [
  const jsonStart = cleaned.search(/[\[{]/);
  if (jsonStart > 0) {
    cleaned = cleaned.substring(jsonStart);
  }
  // Strip any prose after the JSON — find the last } or ]
  const lastBrace = cleaned.lastIndexOf('}');
  const lastBracket = cleaned.lastIndexOf(']');
  const jsonEnd = Math.max(lastBrace, lastBracket);
  if (jsonEnd > 0 && jsonEnd < cleaned.length - 1) {
    cleaned = cleaned.substring(0, jsonEnd + 1);
  }
  return JSON.parse(cleaned);
}

// ─── Core batch analysis ───────────────────────────────────────────────

/**
 * Analyse a batch of up to 6 images with Claude Vision (claude-opus-4-5).
 * @param {Array<{base64: string, mediaType: string, url: string}>} images
 * @returns {Array<object>} Parsed analysis for each image
 */
async function analyseBatch(images) {
  const content = [];

  for (let i = 0; i < images.length; i++) {
    content.push({ type: 'text', text: `Photo ${i + 1}:` });
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: images[i].mediaType,
        data: images[i].base64,
      },
    });
  }

  const plural = images.length > 1;
  content.push({
    type: 'text',
    text: plural
      ? `Analyse all ${images.length} photos above. Return ONLY a JSON array with one analysis object per photo. No prose, no explanation, just the JSON array starting with [ and ending with ].`
      : 'Analyse this photo. Return ONLY the JSON object. No prose, no explanation, just the JSON starting with { and ending with }.',
  });

  const message = await client.messages.create({
    model: 'claude-3-haiku-20240307',
    max_tokens: 4096,
    system: getEnhancedPrompt(),
    messages: [{ role: 'user', content }],
  });

  // Log cost
  try {
    const { logClaude } = require('./costs');
    await logClaude('claude-3-haiku-20240307', message.usage.input_tokens, message.usage.output_tokens, 'vision/analyse_batch');
  } catch {}

  const parsed = parseVisionResponse(message.content[0].text);

  // Normalise: always return an array
  if (Array.isArray(parsed)) return parsed;
  return [parsed];
}

// ─── Main pipeline ─────────────────────────────────────────────────────

/**
 * Full vision analysis pipeline.
 *
 * @param {string[]} imageUrls - URLs of property images
 * @param {number} propertyId - Property ID to link images to in DB
 * @returns {{ analyses: object[], aggregated: object }}
 */
async function analysePropertyImages(imageUrls, propertyId) {
  // Step 1: Download all images and convert to base64
  console.log(`Downloading ${imageUrls.length} images...`);
  const images = [];
  for (const url of imageUrls) {
    try {
      const buffer = await downloadImage(url);
      const mediaType = detectMediaType(url, buffer);
      images.push({
        url,
        base64: buffer.toString('base64'),
        mediaType,
      });
    } catch (err) {
      console.error(`Failed to download ${url}:`, err.message);
    }
  }

  if (images.length === 0) {
    console.error('No images downloaded successfully');
    return null;
  }

  // Step 2: Batch into groups of 6
  const batches = [];
  for (let i = 0; i < images.length; i += BATCH_SIZE) {
    batches.push(images.slice(i, i + BATCH_SIZE));
  }

  // Step 3: Call Claude Vision on each batch
  console.log(`Analysing ${images.length} images in ${batches.length} batch(es)...`);
  const allAnalyses = [];

  for (let i = 0; i < batches.length; i++) {
    console.log(`  Batch ${i + 1}/${batches.length} (${batches[i].length} images)...`);
    const batchResults = await analyseBatch(batches[i]);

    // Pair results with their image metadata
    for (let j = 0; j < batchResults.length; j++) {
      const imgIndex = i * BATCH_SIZE + j;
      if (imgIndex < images.length) {
        batchResults[j]._source_url = images[imgIndex].url;
      }
    }
    allAnalyses.push(...batchResults);
  }

  // Step 4: Store each image + findings in property_images
  console.log('Storing results in database...');
  for (let i = 0; i < allAnalyses.length; i++) {
    const analysis = allAnalyses[i];
    const sourceUrl = analysis._source_url || imageUrls[i] || 'unknown';
    // Keep _source_url for aggregation — will be added to findings

    try {
      // Update existing image record rather than inserting duplicates
      const { rows: existing } = await pool.query(
        'SELECT id FROM property_images WHERE property_id = $1 AND image_url = $2 LIMIT 1',
        [propertyId, sourceUrl]
      );
      if (existing.length > 0) {
        await pool.query(
          'UPDATE property_images SET vision_analysis = $1, analysed_at = NOW(), image_type = $2 WHERE id = $3',
          [JSON.stringify(analysis), analysis.photo_type || 'other', existing[0].id]
        );
      } else {
        await pool.query(
          `INSERT INTO property_images (property_id, source, image_url, image_type, vision_analysis, analysed_at)
           VALUES ($1, 'analysed', $2, $3, $4, NOW())`,
          [propertyId, sourceUrl, analysis.photo_type || 'other', JSON.stringify(analysis)]
        );
      }
    } catch (err) {
      console.error(`Failed to store image analysis:`, err.message);
    }
  }

  // Step 5: Aggregate findings across all images
  const aggregated = aggregateFindings(allAnalyses);

  return { analyses: allAnalyses, aggregated };
}

// ─── Street View analysis ──────────────────────────────────────────────

/**
 * Analyse a Street View image (base64) with claude-sonnet-4-5.
 * Focus: exterior condition, wall cracking, roof condition, damp staining.
 */
async function analyseStreetView(imageBase64) {
  const message = await client.messages.create({
    model: 'claude-3-haiku-20240307',
    max_tokens: 4096,
    system: STREETVIEW_PROMPT,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 },
        },
        { type: 'text', text: 'Analyse this Street View image of the property exterior.' },
      ],
    }],
  });

  return parseVisionResponse(message.content[0].text);
}

// ─── Satellite analysis ────────────────────────────────────────────────

/**
 * Analyse a satellite image (base64) with claude-sonnet-4-5.
 * Focus: roof material, solar panels, outbuildings, roof orientation.
 */
async function analyseSatellite(imageBase64) {
  const message = await client.messages.create({
    model: 'claude-3-haiku-20240307',
    max_tokens: 4096,
    system: SATELLITE_PROMPT,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: imageBase64 },
        },
        { type: 'text', text: 'Analyse this satellite/aerial image of the property.' },
      ],
    }],
  });

  return parseVisionResponse(message.content[0].text);
}

// ─── Aggregation ───────────────────────────────────────────────────────

/**
 * Aggregate per-image analyses into a property-level summary.
 * Returns fields that map directly to property_reports columns.
 */
function aggregateFindings(analyses) {
  const allFindings = [];
  let roofMaterial = 'unknown';
  let solarInstalled = false;
  let roofOrientation = 'unclear';
  let asbestosIndicators = false;
  let securityVisible = false;

  for (const a of analyses) {
    if (Array.isArray(a.findings)) {
      for (const f of a.findings) {
        f.photo_type = a.photo_type || 'unknown';
        f.source_photo = a._source_url || null;
        allFindings.push(f);
      }
    }
    if (a.roof_material && a.roof_material !== 'unknown') roofMaterial = a.roof_material;
    if (a.solar_installed) solarInstalled = true;
    if (a.roof_orientation_estimate && a.roof_orientation_estimate !== 'unclear') roofOrientation = a.roof_orientation_estimate;
    if (a.asbestos_indicators) asbestosIndicators = true;
    if (a.security_visible) securityVisible = true;
  }

  const severityWeight = { CRITICAL: 10, HIGH: 7, MEDIUM: 4, LOW: 2, COSMETIC: 1 };

  // Insurance risk score
  const insuranceFindings = allFindings.filter(f =>
    (f.relevant_to || []).includes('insurance')
  );
  const insuranceSeverity = insuranceFindings.reduce(
    (sum, f) => sum + (severityWeight[f.severity] || 2), 0
  );
  const insuranceRiskScore = Math.min(10, Math.max(1,
    Math.ceil(insuranceSeverity / 3) + (asbestosIndicators ? 3 : 0)
  ));

  // Solar suitability score
  let solarScore = 5;
  if (roofOrientation === 'north') solarScore += 3;
  else if (roofOrientation === 'east' || roofOrientation === 'west') solarScore += 1;
  else if (roofOrientation === 'south') solarScore -= 2;
  if (roofMaterial === 'IBR' || roofMaterial === 'concrete_tile' || roofMaterial === 'clay_tile') solarScore += 1;
  if (roofMaterial === 'corrugated_cement') solarScore -= 1;
  if (solarInstalled) solarScore += 1;
  const roofIssues = allFindings.filter(f =>
    f.category === 'roof' && (f.severity === 'CRITICAL' || f.severity === 'HIGH')
  );
  solarScore -= roofIssues.length;
  const solarSuitabilityScore = Math.min(10, Math.max(1, solarScore));

  // Structural flags
  const structuralFlags = allFindings.filter(f =>
    ['structure', 'walls', 'ceiling'].includes(f.category)
  );

  // Compliance flags
  const complianceFlags = allFindings.filter(f =>
    ['electrical', 'plumbing'].includes(f.category)
  );

  // Repair estimates
  let totalMin = 0, totalMax = 0;
  for (const f of allFindings) {
    const cost = f.estimated_repair_cost_zar || {};
    totalMin += cost.min || 0;
    totalMax += cost.max || 0;
  }

  // Trades flags — grouped by category, sorted by worst severity
  const tradesByCat = {};
  for (const f of allFindings) {
    if ((f.relevant_to || []).includes('trades')) {
      if (!tradesByCat[f.category]) tradesByCat[f.category] = [];
      tradesByCat[f.category].push(f);
    }
  }
  const tradesFlags = Object.entries(tradesByCat)
    .sort(([, a], [, b]) => {
      const worst = (items) => Math.max(...items.map(i => severityWeight[i.severity] || 0));
      return worst(b) - worst(a);
    })
    .map(([cat, items]) => ({ trade_type: cat, items }));

  // Asbestos risk level
  let asbestosRisk = 'NEGLIGIBLE';
  if (asbestosIndicators) {
    asbestosRisk = roofMaterial === 'corrugated_cement' ? 'CRITICAL' : 'HIGH';
  }

  return {
    vision_findings: allFindings,
    asbestos_risk: asbestosRisk,
    structural_flags: structuralFlags,
    compliance_flags: complianceFlags,
    repair_estimates: { total_min_zar: totalMin, total_max_zar: totalMax },
    insurance_risk_score: insuranceRiskScore,
    insurance_flags: insuranceFindings,
    solar_suitability_score: solarSuitabilityScore,
    trades_flags: tradesFlags,
    maintenance_cost_estimate: totalMax,
    roof_material: roofMaterial,
    solar_installed: solarInstalled,
    security_visible: securityVisible,
  };
}

module.exports = {
  analysePropertyImages,
  analyseStreetView,
  analyseSatellite,
  analyseBatch,
  aggregateFindings,
  downloadImage,
  parseVisionResponse,
};
