const https = require('https');
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const pool = require('./db');

const client = new Anthropic();

const BATCH_SIZE = 6;
const VISION_MODEL = 'claude-sonnet-4-6';

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
  security_visible: boolean,
  security_observations: ['array of observed security features or gaps']
}

DEEP ANALYSIS REQUIREMENTS:

WALL CRACKS — For every wall crack found, the observation MUST name:
  1. Crack PATTERN: vertical | horizontal | diagonal | stair-step in mortar joints | map/crazing | spalling
  2. Estimated WIDTH: hairline <1mm | fine 1-3mm | medium 3-10mm | wide >10mm
  3. PROBABLE CAUSE: shrinkage | thermal movement | foundation settlement | subsidence | moisture | poor construction | lateral pressure
  Severity rules: stair-step and horizontal patterns = HIGH minimum. Wide cracks (>10mm) = CRITICAL minimum.

DAMP & MOISTURE — For category 'damp', the observation must classify the condition:
  - WATER_STAIN: past event, now dry, no active risk
  - ACTIVE_MOISTURE: current bleeding or wet surface, high risk
  - EFFLORESCENCE: white salt crystalline deposits on brick or plaster indicating chronic moisture movement through masonry. Rate MEDIUM minimum. Include "possible rising damp — recommend damp survey".
  - MOLD_GROWTH_RISK: dark discoloration with bloom pattern or texture variation. Rate HIGH minimum.

CEILING — For category 'ceiling', the observation must distinguish:
  - HISTORIC_STAIN: old stain, appears dry
  - ACTIVE_LEAK: fresh staining, wet sheen, or progressive ring pattern
  - MOLD_BLOOM: dark patches with texture, particularly at corners or along joists
  - SAG: deformation indicating water pooling above ceiling board

PLUMBING — When pipes are visible, the observation must note:
  - Pipe material if discernible: copper | galvanised | CPVC | PVC | flexi hose | unknown
  - Visible corrosion: none | surface rust | active corrosion with mineral deposits | weeping joint
  - If a geyser is visible: approximate age condition (new | mid-life | old and corroded | not visible)

SECURITY — Populate the security_observations array with observed features:
  boundary wall height estimate, electric fence present/absent, burglar bars on windows,
  security gate at front door, CCTV camera visible, motion sensor lights,
  perimeter type (brick | pre-cast | palisade | none visible).

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
- Wall cracking: classify by PATTERN (vertical|horizontal|diagonal|stair-step|map/crazing|spalling), WIDTH (hairline <1mm|fine 1-3mm|medium 3-10mm|wide >10mm), and PROBABLE CAUSE (shrinkage|thermal|foundation settlement|subsidence|moisture|poor construction|lateral pressure). Stair-step/horizontal = HIGH minimum. Wide >10mm = CRITICAL.
- Roof condition visible from street level
- Damp staining, efflorescence (white salt deposits = possible rising damp), mold indicators
- Boundary walls and security features
- Security observations: boundary wall type and height, electric fence, burglar bars, security gate, CCTV, motion lights, perimeter type
- NEGATIVES nearby: railway lines (noise, vibration, safety risk — severity HIGH), informal settlements/shack areas (safety, property value risk — severity HIGH), industrial buildings, power lines, busy roads, construction sites
- POSITIVES nearby: parks, green spaces, tree-lined streets, mountain/sea views, schools, well-maintained neighbourhood

Return structured JSON:
{
  "photo_type": "exterior",
  "findings": [{
    "category": "roof|walls|damp|electrical|plumbing|ceiling|structure|extension|environment",
    "observation": "exact description with crack classification or damp type as specified above",
    "confidence": "CONFIRMED_VISIBLE|PROBABLE|POSSIBLE|NOT_DETECTABLE",
    "severity": "CRITICAL|HIGH|MEDIUM|LOW|COSMETIC",
    "estimated_repair_cost_zar": { "min": 0, "max": 0 },
    "relevant_to": ["consumer","insurance","trades","solar"]
  }],
  "roof_material": "corrugated_cement|IBR|concrete_tile|clay_tile|other|unknown",
  "solar_installed": false,
  "roof_orientation_estimate": "north|south|east|west|unclear",
  "asbestos_indicators": false,
  "security_visible": false,
  "security_observations": ["array of observed security features or gaps"],
  "nearby_negatives": ["railway line", "informal settlement", etc - only if visible],
  "nearby_positives": ["park/green space", "tree-lined street", etc - only if visible]
}

Rules: Never confirm asbestos — flag indicators only. SA terminology. ZAR costs. Railway lines and informal settlements are ALWAYS HIGH severity when visible.
Return ONLY valid JSON. No markdown fences.`;

const SATELLITE_PROMPT = `You are a certified property inspector with 20 years of South African experience.
Analyse this satellite/aerial image of a property IN DETAIL. Give at least 5-8 specific findings. Focus on:
- Roof material classification (corrugated cement, IBR steel, concrete tiles, clay tiles, flat/membrane)
- Roof condition: patching, discolouration, ponding areas, debris, vegetation growth
- Solar panels visible on roof (count panels if visible, estimate system size)
- Outbuildings, extensions, or structures not on original plans — measure relative to main building
- Roof orientation estimate for solar viability (north-facing is ideal in SA)
- Pool (condition: green/clean, covered/uncovered), garden structures, parking areas
- Property boundary: walls, fencing, open boundaries, shared walls with neighbours
- Stand coverage: what percentage of the stand is built vs garden/open
- Access: driveways, pedestrian paths, number of entrances visible
- Neighbouring properties: condition relative to subject property, density
- NEGATIVES nearby: railway lines or rail corridors (noise, vibration — severity HIGH), informal settlements/shack areas with dense irregular roofing (safety, property value — severity HIGH), industrial zones, landfill sites, power substations, highway proximity, construction sites
- POSITIVES nearby: parks, green belts, sports fields, nature reserves, river/dam (not flood risk), well-spaced residential plots, mountain backdrop, schools, commercial amenities

Return structured JSON:
{
  "photo_type": "roof",
  "findings": [{
    "category": "roof|structure|extension|environment",
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
  "security_visible": false,
  "nearby_negatives": ["railway line", "informal settlement", etc - only if visible in image],
  "nearby_positives": ["park/green space", "sports field", etc - only if visible in image]
}

Rules: Never confirm asbestos — flag indicators only. SA terminology. ZAR costs. Railway lines and informal settlements are ALWAYS HIGH severity when visible.
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

  try {
    let parsed = JSON.parse(cleaned);
    // If Claude returns an array, take the first element
    if (Array.isArray(parsed)) parsed = parsed[0] || {};
    return parsed;
  } catch (e) {
    // Fix common JSON issues from Claude: trailing commas, unescaped quotes in strings
    let fixed = cleaned
      .replace(/,\s*([}\]])/g, '$1')           // trailing commas
      .replace(/:\s*'([^']*)'/g, ': "$1"')      // single quotes → double quotes
      .replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":') // unquoted keys
      .replace(/\n/g, ' ');                      // newlines in strings

    try {
      let parsed = JSON.parse(fixed);
      if (Array.isArray(parsed)) parsed = parsed[0] || {};
      return parsed;
    } catch {
      // Last resort: return a minimal valid response so pipeline doesn't crash
      console.error('[vision] JSON parse failed, returning empty analysis. First 200 chars:', cleaned.substring(0, 200));
      return { photo_type: 'unknown', findings: [], roof_material: 'unknown', solar_installed: false, asbestos_indicators: false, security_visible: false };
    }
  }
}

// ─── Core batch analysis ───────────────────────────────────────────────

/**
 * Analyse a batch of up to 6 images with Claude Vision.
 * @param {Array<{base64: string, mediaType: string, url: string}>} images
 * @param {Array<object>} [hfResults] - Optional HF pre-classification results (one per image)
 * @returns {Array<object>} Parsed analysis for each image
 */
async function analyseBatch(images, hfResults) {
  const content = [];

  for (let i = 0; i < images.length; i++) {
    // Prepend HF context if available
    let photoLabel = `Photo ${i + 1}:`;
    if (hfResults && hfResults[i] && hfResults[i].space_type !== 'unknown') {
      const hf = hfResults[i];
      const crackInfo = hf.crack_detections ? `${hf.crack_detections.length} detection(s)` : 'none';
      photoLabel = `[HF Pre-analysis: space_type=${hf.space_type}, confidence=${hf.space_confidence}, crack_detections=${crackInfo}]\nPhoto ${i + 1}:`;
    }
    content.push({ type: 'text', text: photoLabel });
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
    model: VISION_MODEL,
    max_tokens: 8192,
    system: getEnhancedPrompt(),
    messages: [{ role: 'user', content }],
  });

  // Log cost
  try {
    const { logClaude } = require('./costs');
    await logClaude(VISION_MODEL, message.usage.input_tokens, message.usage.output_tokens, 'vision/analyse_batch');
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

    // Ensure every image in the batch gets a result — even if parse failed
    for (let j = 0; j < batches[i].length; j++) {
      const imgIndex = i * BATCH_SIZE + j;
      const result = batchResults[j] || { photo_type: 'unknown', findings: [], _parse_failed: true };
      if (imgIndex < images.length) {
        result._source_url = images[imgIndex].url;
      }
      allAnalyses.push(result);
    }
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
    model: VISION_MODEL,
    max_tokens: 8192,
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
    model: VISION_MODEL,
    max_tokens: 8192,
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

  // ── Specialist data integration (Session 07) ──

  // DB Board risk
  for (const a of analyses) {
    if (a.db_board) {
      if (a.db_board.overall_condition === 'CRITICAL') {
        complianceFlags.push({ category: 'electrical', observation: 'DB board assessed as critical — likely non-compliant, full rewire may be required. Obtain CoC before purchase.', severity: 'CRITICAL', confidence: 'CONFIRMED_VISIBLE', relevant_to: ['consumer', 'insurance', 'trades'] });
      } else if (a.db_board.overall_condition === 'POOR') {
        complianceFlags.push({ category: 'electrical', observation: 'DB board in poor condition — CoC compliance risk. Budget for electrical inspection.', severity: 'HIGH', confidence: 'PROBABLE', relevant_to: ['consumer', 'insurance', 'trades'] });
      }
      if (a.db_board.visible_burn_marks) insuranceRiskScore = Math.min(10, insuranceRiskScore + 2);
      if (a.db_board.panel_type === 'old_rewirable_fuse_box') insuranceRiskScore = Math.min(10, insuranceRiskScore + 1);
      if (a.db_board.estimated_repair_cost_zar) {
        totalMin += a.db_board.estimated_repair_cost_zar?.min || 0;
        totalMax += a.db_board.estimated_repair_cost_zar?.max || 0;
      }
    }
  }

  // Ceiling risk
  for (const a of analyses) {
    if (a.ceiling) {
      if (a.ceiling.mold_risk_assessment === 'CRITICAL' || a.ceiling.mold_risk_assessment === 'HIGH') {
        structuralFlags.push({ category: 'ceiling', observation: `Ceiling mold risk: ${a.ceiling.mold_risk_assessment}. ${a.ceiling.buyer_note || ''}`, severity: a.ceiling.mold_risk_assessment, confidence: 'CONFIRMED_VISIBLE', relevant_to: ['consumer', 'insurance', 'trades'] });
      }
      if (a.ceiling.sag_or_deformation) {
        structuralFlags.push({ category: 'ceiling', observation: 'Ceiling deformation/sagging detected — indicates water pooling. Structural engineer assessment recommended.', severity: 'CRITICAL', confidence: 'CONFIRMED_VISIBLE', relevant_to: ['consumer', 'insurance', 'trades'] });
      }
      if (a.ceiling.asbestos_tile_indicators) asbestosIndicators = true;
      if (a.ceiling.estimated_remediation_cost_zar) {
        totalMin += a.ceiling.estimated_remediation_cost_zar?.min || 0;
        totalMax += a.ceiling.estimated_remediation_cost_zar?.max || 0;
      }
    }
  }

  // Security score
  let securityScore = null;
  for (const a of analyses) {
    if (a.security_assessment?.security_score != null) {
      if (securityScore === null || a.security_assessment.security_score < securityScore) {
        securityScore = a.security_assessment.security_score;
      }
    }
  }

  // Plumbing risk
  for (const a of analyses) {
    if (a.plumbing) {
      if (['active_corrosion', 'weeping_joint', 'severe'].includes(a.plumbing.corrosion_level)) {
        const sev = a.plumbing.corrosion_level === 'weeping_joint' || a.plumbing.corrosion_level === 'severe' ? 'CRITICAL' : 'HIGH';
        complianceFlags.push({ category: 'plumbing', observation: `Pipe corrosion: ${a.plumbing.corrosion_level}. ${a.plumbing.buyer_note || ''}`, severity: sev, confidence: 'CONFIRMED_VISIBLE', relevant_to: ['consumer', 'insurance', 'trades'] });
      }
      if (a.plumbing.geyser_assessment?.approximate_age_condition === 'end_of_life') {
        allFindings.push({ category: 'plumbing', observation: 'Geyser appears end-of-life — replacement imminent. Budget R5,000-R15,000.', severity: 'HIGH', confidence: 'PROBABLE', estimated_repair_cost_zar: { min: 5000, max: 15000 }, relevant_to: ['consumer', 'insurance', 'trades'] });
        totalMin += 5000; totalMax += 15000;
      }
      if (a.plumbing.geyser_visible && a.plumbing.geyser_assessment?.drip_tray_visible === false) {
        complianceFlags.push({ category: 'plumbing', observation: 'Geyser drip tray not visible — legally required in SA. May affect home insurance validity.', severity: 'MEDIUM', confidence: 'PROBABLE', relevant_to: ['consumer', 'insurance'] });
      }
      if (a.plumbing.estimated_replacement_cost_zar) {
        totalMin += a.plumbing.estimated_replacement_cost_zar?.min || 0;
        totalMax += a.plumbing.estimated_replacement_cost_zar?.max || 0;
      }
    }
  }

  // Recalculate asbestos risk after specialist data
  asbestosRisk = 'NEGLIGIBLE';
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
    security_score: securityScore,
    trades_flags: tradesFlags,
    maintenance_cost_estimate: totalMax,
    roof_material: roofMaterial,
    solar_installed: solarInstalled,
    security_visible: securityVisible,
  };
}

// ─── HuggingFace Pre-Stage ───────────────────────────────────────────────

/**
 * Run HF pre-classification on a single image via Python subprocess.
 * @param {string} imageBase64 - Base64-encoded image data
 * @returns {Promise<{space_type: string, space_confidence: number, crack_detections: Array|null}>}
 */
function runHFPrestage(imageBase64) {
  return new Promise((resolve) => {
    const hfToken = process.env.HF_API_TOKEN;
    if (!hfToken) {
      resolve({ space_type: 'unknown', space_confidence: 0, crack_detections: null });
      return;
    }

    // Write base64 to a temp file (avoids command-line length limits)
    const tmpFile = path.join(os.tmpdir(), `surepath_hf_${Date.now()}_${Math.random().toString(36).slice(2)}.b64`);
    fs.writeFileSync(tmpFile, imageBase64);

    const pyScript = path.join(__dirname, 'vision_analysis.py');
    const child = spawn('python3', [pyScript, 'prestage', tmpFile], {
      env: { ...process.env, HF_API_TOKEN: hfToken },
      timeout: 60000,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => stdout += d);
    child.stderr.on('data', (d) => stderr += d);

    child.on('close', (code) => {
      // Clean up temp file
      try { fs.unlinkSync(tmpFile); } catch {}

      if (code !== 0 || !stdout.trim()) {
        if (stderr) console.error('[hf-prestage] stderr:', stderr.trim());
        resolve({ space_type: 'unknown', space_confidence: 0, crack_detections: null });
        return;
      }

      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        resolve({ space_type: 'unknown', space_confidence: 0, crack_detections: null });
      }
    });

    child.on('error', () => {
      try { fs.unlinkSync(tmpFile); } catch {}
      resolve({ space_type: 'unknown', space_confidence: 0, crack_detections: null });
    });
  });
}

/**
 * Full vision pipeline with HuggingFace pre-classification.
 *
 * 1. Downloads all images
 * 2. Runs HF pre-classification on each (space type + crack detection)
 * 3. Passes HF context to Claude Vision for enhanced analysis
 * 4. Stores HF results alongside vision_analysis in the database
 *
 * Falls back to standard analysePropertyImages() if HF_API_TOKEN is not set.
 *
 * @param {number} propertyId
 * @param {string[]} imageUrls
 * @returns {Promise<{analyses: object[], aggregated: object}|null>}
 */
async function analyseWithHFPrestage(propertyId, imageUrls) {
  const hfToken = process.env.HF_API_TOKEN;
  if (!hfToken) {
    console.log('[vision] HF_API_TOKEN not set — falling back to standard pipeline');
    return analysePropertyImages(imageUrls, propertyId);
  }

  // Step 1: Download all images
  console.log(`[vision+hf] Downloading ${imageUrls.length} images...`);
  const images = [];
  for (const url of imageUrls) {
    try {
      const buffer = await downloadImage(url);
      const mediaType = detectMediaType(url, buffer);
      images.push({ url, base64: buffer.toString('base64'), mediaType });
    } catch (err) {
      console.error(`[vision+hf] Failed to download ${url}:`, err.message);
    }
  }

  if (images.length === 0) {
    console.error('[vision+hf] No images downloaded');
    return null;
  }

  // Step 2: Run HF pre-classification on each image (parallel)
  console.log(`[vision+hf] Running HF pre-classification on ${images.length} images...`);
  const hfResults = await Promise.all(
    images.map((img) => runHFPrestage(img.base64))
  );

  const classified = hfResults.filter(r => r.space_type !== 'unknown').length;
  const crackDetected = hfResults.filter(r => r.crack_detections && r.crack_detections.length > 0).length;
  console.log(`[vision+hf] HF classified ${classified}/${images.length} images, ${crackDetected} with crack detections`);

  // Step 3: Batch into groups of 6 and analyse with Claude Vision + HF context
  const batches = [];
  const hfBatches = [];
  for (let i = 0; i < images.length; i += BATCH_SIZE) {
    batches.push(images.slice(i, i + BATCH_SIZE));
    hfBatches.push(hfResults.slice(i, i + BATCH_SIZE));
  }

  console.log(`[vision+hf] Analysing ${images.length} images in ${batches.length} batch(es) with Claude Vision...`);
  const allAnalyses = [];

  for (let i = 0; i < batches.length; i++) {
    console.log(`  Batch ${i + 1}/${batches.length} (${batches[i].length} images)...`);
    const batchResults = await analyseBatch(batches[i], hfBatches[i]);

    // Ensure every image in the batch gets a result — even if parse failed
    for (let j = 0; j < batches[i].length; j++) {
      const imgIndex = i * BATCH_SIZE + j;
      const result = batchResults[j] || { photo_type: 'unknown', findings: [], _parse_failed: true };
      if (imgIndex < images.length) {
        result._source_url = images[imgIndex].url;
      }
      allAnalyses.push(result);
    }
  }

  // Step 4: Store results in database
  console.log('[vision+hf] Storing results...');
  for (let i = 0; i < allAnalyses.length; i++) {
    const analysis = allAnalyses[i];
    const sourceUrl = analysis._source_url || imageUrls[i] || 'unknown';
    const hfData = hfResults[i] || null;

    try {
      const { rows: existing } = await pool.query(
        'SELECT id FROM property_images WHERE property_id = $1 AND image_url = $2 LIMIT 1',
        [propertyId, sourceUrl]
      );

      if (existing.length > 0) {
        // Store vision analysis
        await pool.query(
          'UPDATE property_images SET vision_analysis = $1, analysed_at = NOW(), image_type = $2 WHERE id = $3',
          [JSON.stringify(analysis), analysis.photo_type || 'other', existing[0].id]
        );
        // Merge HF pre-stage results into vision_analysis
        if (hfData) {
          await pool.query(
            'UPDATE property_images SET vision_analysis = vision_analysis || $1::jsonb WHERE id = $2',
            [JSON.stringify({ hf_prestage: hfData }), existing[0].id]
          );
        }
      } else {
        const fullAnalysis = hfData ? { ...analysis, hf_prestage: hfData } : analysis;
        await pool.query(
          `INSERT INTO property_images (property_id, source, image_url, image_type, vision_analysis, analysed_at)
           VALUES ($1, 'analysed', $2, $3, $4, NOW())`,
          [propertyId, sourceUrl, analysis.photo_type || 'other', JSON.stringify(fullAnalysis)]
        );
      }
    } catch (err) {
      console.error('[vision+hf] Failed to store:', err.message);
    }
  }

  // Step 5: Aggregate
  const aggregated = aggregateFindings(allAnalyses);

  return { analyses: allAnalyses, aggregated, hfResults };
}

// ─── Specialist: DB Board Analysis (Session 02) ────────────────────────

const DB_BOARD_PROMPT = `You are a certified South African electrician reviewing a property's electrical distribution board photo for a buyer risk report.

Assess the DB board and return ONLY valid JSON:
{
  "photo_type": "db_board",
  "db_board": {
    "panel_type": "old_rewirable_fuse_box | semi_modern_mcb | modern_rcbo | unknown",
    "approximate_era": "pre-1980 | 1980-2000 | post-2000 | unknown",
    "circuit_breakers_visible": null,
    "rcd_rcbo_present": false,
    "earth_leakage_present": false,
    "visible_burn_marks": false,
    "visible_scorch_discolouration": false,
    "cloth_rubber_legacy_wiring_visible": false,
    "double_tapping_indicators": false,
    "open_knockouts_missing_blanks": false,
    "labelling_visible": false,
    "overall_condition": "GOOD | FAIR | POOR | CRITICAL",
    "coc_implications": "plain English sentence about Certificate of Compliance risk",
    "buyer_note": "one sentence for the buyer"
  },
  "findings": [{
    "category": "electrical",
    "observation": "description",
    "confidence": "CONFIRMED_VISIBLE|PROBABLE|POSSIBLE|NOT_DETECTABLE",
    "severity": "CRITICAL|HIGH|MEDIUM|LOW|COSMETIC",
    "estimated_repair_cost_zar": { "min": 0, "max": 0 },
    "relevant_to": ["consumer","insurance","trades"]
  }]
}

SA CONTEXT:
- Pre-1980 fuse boxes are not CoC compliant, require full rewire — R15,000-R45,000
- No earth leakage protection = CoC failure
- Cloth-insulated wiring (brown/black fabric sleeving) = fire hazard, rate CRITICAL
- Double-tapping (two wires under one breaker) = non-compliant, rate HIGH
- Missing blanks = live-exposure risk, rate HIGH
- RCBO panels (individual protection per circuit) = best practice post-2010

Return ONLY valid JSON. No markdown fences.`;

async function analyseDBBoard(imageBase64) {
  const message = await client.messages.create({
    model: VISION_MODEL,
    max_tokens: 8192,
    system: DB_BOARD_PROMPT,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
        { type: 'text', text: 'Analyse this electrical distribution board.' },
      ],
    }],
  });

  try {
    const { logClaude } = require('./costs');
    await logClaude(VISION_MODEL, message.usage.input_tokens, message.usage.output_tokens, 'vision/db_board');
  } catch {}

  return parseVisionResponse(message.content[0].text);
}

// ─── Specialist: Ceiling Deep Analysis (Session 03) ─────────────────────

const CEILING_PROMPT = `You are a building defects surveyor reviewing ceiling photos for a South African property buyer.

Return ONLY valid JSON:
{
  "photo_type": "ceiling",
  "ceiling": {
    "material_type": "plasterboard | fibre_cement | rhino_board | tongue_groove_timber | suspended_tile | unknown",
    "condition_overall": "GOOD | FAIR | POOR | CRITICAL",
    "stain_type": "NONE | HISTORIC_DRY_STAIN | ACTIVE_LEAK | MOLD_BLOOM | EFFLORESCENCE | CONDENSATION_PATTERN",
    "stain_coverage_estimate": "none | spot (<10%) | moderate (10-30%) | extensive (>30%)",
    "sag_or_deformation": false,
    "asbestos_tile_indicators": false,
    "note_on_asbestos": "if asbestos_tile_indicators true, describe visual cues. Never confirm, flag for testing only.",
    "mold_risk_assessment": "NONE | LOW | MEDIUM | HIGH | CRITICAL",
    "estimated_remediation_cost_zar": { "min": 0, "max": 0 },
    "buyer_note": "one sentence for a non-technical buyer"
  },
  "findings": [{
    "category": "ceiling",
    "observation": "description",
    "confidence": "CONFIRMED_VISIBLE|PROBABLE|POSSIBLE|NOT_DETECTABLE",
    "severity": "CRITICAL|HIGH|MEDIUM|LOW|COSMETIC",
    "estimated_repair_cost_zar": { "min": 0, "max": 0 },
    "relevant_to": ["consumer","insurance","trades"]
  }]
}

SA CONTEXT:
- Asbestos ceiling tiles common pre-1985: square/rectangular compressed fibre, slightly textured. Flag in older properties.
- Mold commonly caused by poor roof waterproofing or poor ventilation in bathrooms/kitchens
- Active leak stains show concentric ring patterns or yellowing at edges
- Sagging plasterboard = water pooling = likely ongoing roof leak
- Costs ZAR: minor stain R500-R2,000; mold treatment R2,000-R8,000; full ceiling replacement R8,000-R25,000

Return ONLY valid JSON. No markdown fences.`;

async function analyseCeilingDeep(imageBase64) {
  const message = await client.messages.create({
    model: VISION_MODEL,
    max_tokens: 8192,
    system: CEILING_PROMPT,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
        { type: 'text', text: 'Analyse this ceiling photo for defects, damp, and mold.' },
      ],
    }],
  });

  try {
    const { logClaude } = require('./costs');
    await logClaude(VISION_MODEL, message.usage.input_tokens, message.usage.output_tokens, 'vision/ceiling_deep');
  } catch {}

  return parseVisionResponse(message.content[0].text);
}

// ─── Specialist: Exterior Security Analysis (Session 04) ────────────────

const SECURITY_PROMPT = `You are a South African physical security consultant reviewing a property exterior photo for a buyer.

South Africa has high residential burglary rates — security is a primary buyer concern.

Return ONLY valid JSON:
{
  "photo_type": "exterior",
  "security_assessment": {
    "perimeter_type": "brick_wall | pre_cast_panel | palisade_fence | timber_fence | no_perimeter | mixed | unknown",
    "perimeter_height_estimate": "low_under_1m | medium_1_to_18m | high_1_8_to_2_4m | very_high_over_2_4m | unknown",
    "perimeter_condition": "GOOD | FAIR | DAMAGED | CRITICAL | NOT_VISIBLE",
    "electric_fence": "present_and_active | present_condition_unknown | absent | not_visible",
    "burglar_bars_on_windows": "all_visible | partial | none_visible | not_applicable",
    "security_gate_main_entry": "present | absent | not_visible",
    "cctv_cameras_visible": false,
    "security_lighting_visible": false,
    "intercom_or_access_control": false,
    "visibility_from_street": "fully_visible | partially_obscured | heavily_obscured",
    "concealment_risk": false,
    "blind_spot_indicators": [],
    "entry_point_count_estimate": null,
    "weakest_entry_point": "one sentence describing the most vulnerable visible access point",
    "security_score": 5,
    "buyer_note": "one sentence for a non-technical buyer",
    "recommended_upgrades": []
  },
  "findings": [{
    "category": "structure",
    "observation": "description",
    "confidence": "CONFIRMED_VISIBLE|PROBABLE|POSSIBLE|NOT_DETECTABLE",
    "severity": "CRITICAL|HIGH|MEDIUM|LOW|COSMETIC",
    "estimated_repair_cost_zar": { "min": 0, "max": 0 },
    "relevant_to": ["consumer","insurance"]
  }]
}

SA CONTEXT:
- Pre-cast panel walls lower security than brick — panels can be lifted from channels
- Electric fencing is a strong deterrent in SA
- Slam-lock security gates preferable to expanding trellis gates
- Heavy planting against walls creates concealment risk
- Visibility from street is protective — well-lit visible properties are lower risk
- Costs ZAR: electric fence R8,000-R25,000; security gate R3,000-R8,000; CCTV 4-camera R6,000-R15,000; perimeter lighting R2,000-R5,000

Return ONLY valid JSON. No markdown fences.`;

async function analyseExteriorSecurity(imageBase64) {
  const message = await client.messages.create({
    model: VISION_MODEL,
    max_tokens: 8192,
    system: SECURITY_PROMPT,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
        { type: 'text', text: 'Analyse this property exterior for security features and vulnerabilities.' },
      ],
    }],
  });

  try {
    const { logClaude } = require('./costs');
    await logClaude(VISION_MODEL, message.usage.input_tokens, message.usage.output_tokens, 'vision/exterior_security');
  } catch {}

  return parseVisionResponse(message.content[0].text);
}

// ─── Specialist: Plumbing & Geyser Analysis (Session 05) ────────────────

const PLUMBING_PROMPT = `You are a South African licensed plumber reviewing property photos for a buyer risk report.

Return ONLY valid JSON:
{
  "photo_type": "plumbing",
  "plumbing": {
    "pipe_material_visible": "copper | galvanised_steel | cpvc | upvc | pex | flexi_hose | mixed | no_pipes_visible",
    "corrosion_level": "none | surface_rust_minor | active_corrosion | weeping_joint | severe",
    "geyser_visible": false,
    "geyser_assessment": {
      "approximate_age_condition": "new_under_5yr | mid_life_5_10yr | old_over_10yr | end_of_life | not_visible",
      "drip_tray_visible": false,
      "drip_tray_condition": "clean | stained_past_overflow | absent | not_visible",
      "flue_pipe_condition": "good | corroded | absent_where_expected | not_applicable | not_visible",
      "pressure_relief_valve_visible": false,
      "insulation_blanket_visible": false,
      "brand_legible": null,
      "buyer_note": "one sentence about geyser risk"
    },
    "drain_waste_pipes_condition": "good | stained | leaking | not_visible",
    "visible_leaks_or_water_damage": false,
    "estimated_remaining_life_years": null,
    "estimated_replacement_cost_zar": { "min": 0, "max": 0 },
    "buyer_note": "one sentence for a non-technical buyer"
  },
  "findings": [{
    "category": "plumbing",
    "observation": "description",
    "confidence": "CONFIRMED_VISIBLE|PROBABLE|POSSIBLE|NOT_DETECTABLE",
    "severity": "CRITICAL|HIGH|MEDIUM|LOW|COSMETIC",
    "estimated_repair_cost_zar": { "min": 0, "max": 0 },
    "relevant_to": ["consumer","insurance","trades"]
  }]
}

SA CONTEXT:
- Galvanised steel pipes common pre-1985, corrode internally reducing pressure. Full house replumb: R25,000-R80,000.
- Flexi hoses (braided stainless connectors under basins/toilets) fail with age — leading cause of home flooding in SA. Flag any over 5 years old.
- Geysers last 8-12 years. End-of-life without drip tray = major insurance claim risk. Tray legally required.
- Solar geysers and heat pumps are positive — note if visible.
- Geyser replacement: R5,000-R15,000 standard 150L. Heat pump: R18,000-R35,000.
- Active corrosion (orange-brown mineral deposits at joints) = HIGH minimum. Weeping joints = CRITICAL.
- Check under-sink flexi hoses specifically — highest failure risk.

Return ONLY valid JSON. No markdown fences.`;

async function analysePlumbing(imageBase64) {
  const message = await client.messages.create({
    model: VISION_MODEL,
    max_tokens: 8192,
    system: PLUMBING_PROMPT,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
        { type: 'text', text: 'Analyse this photo for plumbing condition, pipe material, corrosion, and geyser risk.' },
      ],
    }],
  });

  try {
    const { logClaude } = require('./costs');
    await logClaude(VISION_MODEL, message.usage.input_tokens, message.usage.output_tokens, 'vision/plumbing');
  } catch {}

  return parseVisionResponse(message.content[0].text);
}

// ─── Temporal Change Detection (Session 09) ─────────────────────────────

const TEMPORAL_PROMPT = `Compare these two Street View images of the same South African property, taken at different points in time. Image 1 is the more recent image. Image 2 is the historical reference.

Identify any changes between the two that a property buyer should know about. Focus on:
- Roof: patched, replaced partially/fully, or deteriorated? Full replacement is positive. Partial patching may indicate problem areas.
- Exterior walls: new cracks, new paint (may cover defects), new staining, crumbling plaster
- Structures: new extensions or outbuildings (potential planning permission issue)
- Boundary walls: damage, replacement sections, lowered height
- General condition trajectory: improving, stable, or deteriorating?

Return ONLY valid JSON:
{
  "comparison_possible": true,
  "temporal_gap_estimate": "3-5 years",
  "roof_change_detected": false,
  "roof_change_description": null,
  "wall_change_detected": false,
  "wall_change_description": null,
  "structure_change_detected": false,
  "structure_change_description": null,
  "condition_trajectory": "IMPROVING | STABLE | DETERIORATING | UNCLEAR",
  "red_flags": [],
  "positive_signals": [],
  "buyer_note": "one sentence summarising what the temporal comparison means for the buyer"
}

No markdown fences.`;

async function analyseTemporalChange(currentBase64, historicalBase64) {
  const message = await client.messages.create({
    model: VISION_MODEL,
    max_tokens: 8192,
    system: TEMPORAL_PROMPT,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Image 1 (current):' },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: currentBase64 } },
        { type: 'text', text: 'Image 2 (historical):' },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: historicalBase64 } },
        { type: 'text', text: 'Compare these two images. What has changed between the historical and current photos?' },
      ],
    }],
  });

  try {
    const { logClaude } = require('./costs');
    await logClaude(VISION_MODEL, message.usage.input_tokens, message.usage.output_tokens, 'vision/temporal_change');
  } catch {}

  return parseVisionResponse(message.content[0].text);
}

// ─── Utility: detect media type ─────────────────────────────────────────

// Re-export detectMediaType for external use
const _detectMediaType = detectMediaType;

module.exports = {
  analysePropertyImages,
  analyseWithHFPrestage,
  analyseStreetView,
  analyseSatellite,
  analyseBatch,
  aggregateFindings,
  downloadImage,
  parseVisionResponse,
  runHFPrestage,
  detectMediaType: _detectMediaType,
  // Specialist functions (Sessions 02-05)
  analyseDBBoard,
  analyseCeilingDeep,
  analyseExteriorSecurity,
  analysePlumbing,
  // Temporal (Session 09)
  analyseTemporalChange,
};
