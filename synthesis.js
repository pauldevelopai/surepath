const Anthropic = require('@anthropic-ai/sdk');
const pool = require('./db');

const client = new Anthropic();

const SYNTHESIS_SYSTEM_PROMPT = `You are Surepath's property intelligence engine. Synthesise all provided data into a structured property report. The buyer paid R149 for an honest friend's advice, not a liability-conscious institution's hedge.

Rules:
- No vague language. No 'it depends'. Make a call.
- All findings framed as RISK INDICATORS, not confirmed defects
- Decision must be one of: BUY | NEGOTIATE | INSPECT_FIRST | WALK_AWAY
- Decision reasoning: 3 sentences max. Plain language. No jargon.
- NEVER fabricate data. Do NOT invent comparable sales, addresses, prices, or scores.
- Do NOT generate insurance_risk_score, solar_suitability_score, or crime_risk_score — these come from verified external data sources, not AI.
- Set comparables to an empty array [] — we do not have verified comparable sales data.
- Use the actual property data provided (bedrooms, bathrooms, floor area, features, vision findings)
- If vision_findings are provided, use them for structural_flags, compliance_flags, and repair_estimates
- Base the AVM on the asking price and property features, clearly label it as an AI estimate
- For repair_estimates.items, include category, description, min and max costs — never use "N/A"
- For structural_flags and compliance_flags, include the actual observation text, never "N/A"
- Focus the decision on helping the buyer: what are the real risks, what should they negotiate, what will it cost in year one`;

// ─── Building age risk matrix ──────────────────────────────────────────

const AGE_RISK_MATRIX = {
  'pre-1977': {
    label: 'Pre-1977',
    asbestos: 'CRITICAL',
    electrical: 'CRITICAL',
    plumbing: 'HIGH',
    notes: 'High probability of asbestos in roof/ceiling/pipes. Original wiring almost certainly not compliant. Galvanised plumbing likely corroded.',
  },
  '1977-1990': {
    label: '1977–1990',
    asbestos: 'HIGH',
    electrical: 'HIGH',
    plumbing: 'MEDIUM',
    notes: 'Asbestos still commonly used until late 1980s. Wiring may be undersized for modern loads. Copper plumbing likely but check geyser connections.',
  },
  '1990-2000': {
    label: '1990–2000',
    asbestos: 'MEDIUM',
    electrical: 'MEDIUM',
    plumbing: 'MEDIUM',
    notes: 'Asbestos phased out but may be in ceiling boards. Electrical should have earth leakage but verify. Plumbing generally acceptable.',
  },
  '2000-2010': {
    label: '2000–2010',
    asbestos: 'NEGLIGIBLE',
    electrical: 'LOW',
    plumbing: 'LOW',
    notes: 'Asbestos banned. Electrical should comply with SANS 10142. Plumbing modern materials.',
  },
  'post-2010': {
    label: 'Post-2010',
    asbestos: 'NEGLIGIBLE',
    electrical: 'LOW',
    plumbing: 'LOW',
    notes: 'Modern build standards. Should have valid CoC. Check for builder defects within warranty period.',
  },
};

/**
 * Parse construction_era string into a risk matrix key.
 */
function classifyEra(constructionEra) {
  if (!constructionEra) return null; // unknown — don't assume

  const era = constructionEra.toLowerCase().trim();

  // Decade strings like "1960s", "1980s", "1990s" — check first
  const decadeMatch = era.match(/(\d{3})0s/);
  if (decadeMatch) {
    // Use mid-decade as representative year
    const decadeMid = parseInt(decadeMatch[1]) * 10 + 5;
    if (decadeMid < 1977) return 'pre-1977';
    if (decadeMid <= 1990) return '1977-1990';
    if (decadeMid <= 2000) return '1990-2000';
    if (decadeMid <= 2010) return '2000-2010';
    return 'post-2010';
  }

  // Try to extract a specific year
  const yearMatch = era.match(/(\d{4})/);
  if (yearMatch) {
    const year = parseInt(yearMatch[1]);
    if (year < 1977) return 'pre-1977';
    if (year <= 1990) return '1977-1990';
    if (year <= 2000) return '1990-2000';
    if (year <= 2010) return '2000-2010';
    return 'post-2010';
  }

  // Keywords
  if (era.includes('pre-war') || era.includes('victorian') || era.includes('edwardian')) return 'pre-1977';
  if (era.includes('modern') || era.includes('new') || era.includes('recent')) return 'post-2010';

  return 'pre-1977'; // default to worst case
}

// ─── Suburb intelligence from DB ───────────────────────────────────────

async function getSuburbIntelligence(suburb, city) {
  if (!suburb || !city) return null;

  // Query actual reports in this suburb for real stats
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) AS total_reports,
       AVG(pr.asking_price) AS avg_asking,
       MIN(pr.asking_price) AS min_asking,
       MAX(pr.asking_price) AS max_asking,
       AVG(pr.avm_low) AS avg_avm_low,
       AVG(pr.avm_high) AS avg_avm_high
     FROM property_reports pr
     JOIN properties p ON p.id = pr.property_id
     WHERE p.suburb ILIKE $1 AND p.city ILIKE $2
       AND pr.status = 'complete'`,
    [suburb, city]
  );

  const stats = rows[0];
  const hasData = parseInt(stats.total_reports) > 0;

  return {
    suburb,
    city,
    total_reports_in_suburb: parseInt(stats.total_reports),
    avg_asking_price: hasData ? Math.round(parseFloat(stats.avg_asking)) : null,
    avg_avm_low: hasData ? Math.round(parseFloat(stats.avg_avm_low)) : null,
    avg_avm_high: hasData ? Math.round(parseFloat(stats.avg_avm_high)) : null,
    source: hasData ? 'surepath_reports' : 'no_suburb_data',
    note: hasData ? null : 'No existing reports in this suburb — Claude will estimate from property data and asking price',
  };
}

// ─── Main synthesis function ───────────────────────────────────────────

/**
 * Synthesise a full property report.
 *
 * @param {number} propertyId
 * @param {number} askingPrice - ZAR
 * @returns {{ report_id: number, report: object }}
 */
async function synthesiseReport(propertyId, askingPrice) {
  // Step 1: Fetch all data from DB
  console.log(`[synthesis] Fetching data for property ${propertyId}...`);

  const [propertyRes, deedsRes, imagesRes] = await Promise.all([
    pool.query('SELECT * FROM properties WHERE id = $1', [propertyId]),
    pool.query('SELECT * FROM deeds_data WHERE property_id = $1 ORDER BY fetched_at DESC LIMIT 1', [propertyId]),
    pool.query('SELECT vision_analysis FROM property_images WHERE property_id = $1 AND vision_analysis IS NOT NULL', [propertyId]),
  ]);

  if (propertyRes.rows.length === 0) {
    throw new Error(`Property ${propertyId} not found`);
  }

  const property = propertyRes.rows[0];
  const deeds = deedsRes.rows[0] || null;
  const visionAnalyses = imagesRes.rows
    .map(r => r.vision_analysis)
    .filter(Boolean);

  // Step 2: Building age risk matrix
  const eraKey = classifyEra(property.construction_era);
  const ageRisk = eraKey ? AGE_RISK_MATRIX[eraKey] : null;

  // Step 3: Suburb intelligence from existing reports
  const suburbIntel = await getSuburbIntelligence(property.suburb, property.city);

  // Step 4: Assemble context object — include ALL collected data
  const context = {
    property: {
      id: property.id,
      erf_number: property.erf_number,
      address: property.address_normalised || property.address_raw,
      street_address: property.street_address,
      suburb: property.suburb,
      city: property.city,
      province: property.province,
      property_type: property.property_type,
      stand_size_sqm: property.stand_size_sqm,
      floor_area_sqm: property.floor_area_sqm,
      bedrooms: property.bedrooms,
      bathrooms: property.bathrooms,
      parking_spaces: property.parking_spaces,
      garages: property.garages,
      construction_era: property.construction_era,
      suburb_crime_score: property.suburb_crime_score,
      // Listing data
      asking_price_from_listing: property.asking_price,
      levies: property.levies,
      rates_and_taxes: property.rates_and_taxes,
      listing_date: property.listing_date,
      pet_friendly: property.pet_friendly,
      furnished: property.furnished,
      description: property.description,
      agent_name: property.agent_name,
      agency_name: property.agency_name,
      // Vision-derived
      roof_material: property.roof_material,
      roof_orientation: property.roof_orientation,
      solar_installed: property.solar_installed,
      security_visible: property.security_visible,
      // Extracted features
      building_name: property.building_name,
      views: property.views,
      flooring: property.flooring,
      has_pool: property.has_pool,
      has_garden: property.has_garden,
      has_braai: property.has_braai,
      has_jacuzzi: property.has_jacuzzi,
      has_balcony: property.has_balcony,
      has_aircon: property.has_aircon,
      has_alarm: property.has_alarm,
      has_borehole: property.has_borehole,
      has_solar_geyser: property.has_solar_geyser,
      has_generator: property.has_generator,
      selling_points: property.selling_points,
      // Risk data
      water_quality_score: property.water_quality_score,
      sewerage_quality_score: property.sewerage_quality_score,
      dolomite_risk: property.dolomite_risk,
      mining_subsidence_risk: property.mining_subsidence_risk,
      flood_zone: property.flood_zone,
      heritage_site: property.heritage_site,
      electrical_coc_required: property.electrical_coc_required,
      plumbing_coc_required: property.plumbing_coc_required,
      beetle_cert_required: property.beetle_cert_required,
    },
    asking_price: askingPrice,
    deeds: deeds ? {
      registered_owner: deeds.registered_owner,
      title_deed_ref: deeds.title_deed_ref,
      municipal_value: deeds.municipal_value,
      transfer_history: deeds.transfer_history,
    } : null,
    building_age_risk: ageRisk ? {
      era: ageRisk.label,
      asbestos_risk: ageRisk.asbestos,
      electrical_risk: ageRisk.electrical,
      plumbing_risk: ageRisk.plumbing,
      notes: ageRisk.notes,
    } : {
      era: 'Unknown',
      asbestos_risk: 'UNKNOWN — construction era not determined',
      electrical_risk: 'UNKNOWN',
      plumbing_risk: 'UNKNOWN',
      notes: 'Construction era is not known. Cannot assess age-related risks. Determine the building age to get accurate risk assessment.',
    },
    suburb_intelligence: suburbIntel,
    vision_findings: visionAnalyses,
  };

  // Step 5: Call Claude Opus for synthesis
  console.log('[synthesis] Calling Claude Opus for report synthesis...');

  const message = await client.messages.create({
    model: 'claude-3-haiku-20240307',
    max_tokens: 4096,
    system: SYNTHESIS_SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `Synthesise a complete Surepath property report from this data. Return valid JSON only, no markdown fences.

The JSON must have these exact fields:
{
  "asking_price": number,
  "avm_low": number,
  "avm_high": number,
  "price_verdict": "overpriced|fair|underpriced",
  "comparables": [{"address": "", "price": 0, "sold_date": "", "size_sqm": 0}],
  "suburb_intelligence": {},
  "vision_findings": [],
  "asbestos_risk": "CRITICAL|HIGH|MEDIUM|LOW|NEGLIGIBLE",
  "structural_flags": [],
  "compliance_flags": [],
  "repair_estimates": {"total_min_zar": 0, "total_max_zar": 0, "items": []},
  "negotiation_intel": {"days_on_market": 0, "suggested_offer": 0, "negotiation_points": []},
  "decision": "BUY|NEGOTIATE|INSPECT_FIRST|WALK_AWAY",
  "decision_reasoning": "",
  "insurance_risk_score": 0,
  "insurance_flags": [],
  "crime_risk_score": 0,
  "solar_suitability_score": 0,
  "trades_flags": [],
  "maintenance_cost_estimate": 0
}

Property data:
${JSON.stringify(context, null, 2)}`,
    }],
  });

  // Parse response — resilient to malformed JSON from Claude
  let reportText = message.content[0].text.trim();
  if (reportText.startsWith('```')) {
    reportText = reportText.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  }
  // Strip prose before/after JSON
  const jStart = reportText.search(/[\[{]/);
  if (jStart > 0) reportText = reportText.substring(jStart);
  const jEnd = Math.max(reportText.lastIndexOf('}'), reportText.lastIndexOf(']'));
  if (jEnd > 0 && jEnd < reportText.length - 1) reportText = reportText.substring(0, jEnd + 1);

  let report;
  try {
    report = JSON.parse(reportText);
  } catch (e) {
    // Fix trailing commas and retry
    const fixed = reportText.replace(/,\s*([}\]])/g, '$1').replace(/\n/g, ' ');
    try {
      report = JSON.parse(fixed);
    } catch {
      console.error('[synthesis] JSON parse failed, using fallback report');
      report = {
        decision: 'INSPECT_FIRST',
        decision_reasoning: 'Report synthesis produced malformed output. Manual inspection recommended.',
        price_verdict: null,
        comparables: [],
        suburb_intelligence: {},
        negotiation_intel: [],
      };
    }
  }

  // Track API cost — use actual Haiku pricing
  const inputTokens = message.usage.input_tokens || 0;
  const outputTokens = message.usage.output_tokens || 0;
  const costUSD = (inputTokens * 0.25 + outputTokens * 1.25) / 1_000_000;
  const costZAR = Math.round(costUSD * 18.5 * 100) / 100;

  // Log to api_costs table
  try {
    const { logClaude } = require('./costs');
    await logClaude('claude-3-haiku-20240307', inputTokens, outputTokens, 'synthesis/report', propertyId);
  } catch {}

  // Step 6: Store in property_reports
  console.log('[synthesis] Storing report in database...');

  const { rows: reportRows } = await pool.query(
    `INSERT INTO property_reports (
      property_id, asking_price, avm_low, avm_high, price_verdict,
      comparables, suburb_intelligence, vision_findings,
      asbestos_risk, structural_flags, compliance_flags,
      repair_estimates, negotiation_intel,
      decision, decision_reasoning,
      insurance_risk_score, insurance_flags,
      crime_risk_score, solar_suitability_score,
      trades_flags, maintenance_cost_estimate,
      status, generation_cost_zar
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8,
      $9, $10, $11,
      $12, $13,
      $14, $15,
      $16, $17,
      $18, $19,
      $20, $21,
      'complete', $22
    ) RETURNING id`,
    [
      propertyId,
      report.asking_price || askingPrice,
      report.avm_low,
      report.avm_high,
      report.price_verdict,
      JSON.stringify(report.comparables),
      JSON.stringify(report.suburb_intelligence),
      JSON.stringify(report.vision_findings),
      report.asbestos_risk,
      JSON.stringify(report.structural_flags),
      JSON.stringify(report.compliance_flags),
      JSON.stringify(report.repair_estimates),
      JSON.stringify(report.negotiation_intel),
      report.decision,
      report.decision_reasoning,
      report.insurance_risk_score,
      JSON.stringify(report.insurance_flags),
      report.crime_risk_score,
      report.solar_suitability_score,
      JSON.stringify(report.trades_flags),
      report.maintenance_cost_estimate,
      costZAR,
    ]
  );

  const reportId = reportRows[0].id;

  // Step 7: Update properties with vision-derived fields
  // Extract from vision findings or from the report
  const visionMeta = extractVisionMeta(visionAnalyses, report);
  await pool.query(
    `UPDATE properties SET
       solar_installed = COALESCE($1, solar_installed),
       security_visible = COALESCE($2, security_visible),
       roof_material = COALESCE($3, roof_material),
       roof_orientation = COALESCE($4, roof_orientation)
     WHERE id = $5`,
    [
      visionMeta.solar_installed,
      visionMeta.security_visible,
      visionMeta.roof_material,
      visionMeta.roof_orientation,
      propertyId,
    ]
  );

  console.log(`[synthesis] Report ${reportId} created. Cost: R${costZAR}`);

  return { report_id: reportId, report };
}

/**
 * Extract property-level vision metadata from analyses or synthesised report.
 */
function extractVisionMeta(visionAnalyses, report) {
  let solarInstalled = null;
  let securityVisible = null;
  let roofMaterial = null;
  let roofOrientation = null;

  // Try from raw vision analyses first
  for (const va of visionAnalyses) {
    if (va.solar_installed === true) solarInstalled = true;
    if (va.security_visible === true) securityVisible = true;
    if (va.roof_material && va.roof_material !== 'unknown') roofMaterial = va.roof_material;
    if (va.roof_orientation_estimate && va.roof_orientation_estimate !== 'unclear') {
      roofOrientation = va.roof_orientation_estimate;
    }
  }

  return { solar_installed: solarInstalled, security_visible: securityVisible, roof_material: roofMaterial, roof_orientation: roofOrientation };
}

module.exports = {
  synthesiseReport,
  classifyEra,
  AGE_RISK_MATRIX,
  getSuburbIntelligence,
  extractVisionMeta,
};
