/**
 * Seed rag_chunks from ALL live data sources:
 *   - area_risk_data (climate, crime, dolomite, water, etc.)
 *   - crime_incidents (aggregated by suburb)
 *   - security coverage (aggregated by suburb)
 *   - properties (listings with descriptions)
 *   - holly_evidence (past vision findings)
 *   - property_reports (report decisions)
 *   - data_feedback (user corrections and confirmations)
 *
 * Run once, then re-run after scraper updates.
 *
 * Usage: node seed-live-data.js
 */
require('dotenv').config();
const pool = require('./db');
const { upsertChunk, warmup } = require('./rag');

// ─── Format area_risk_data row into embeddable text ──────────────────
function formatAreaRisk(row) {
  const d = typeof row.details === 'string' ? JSON.parse(row.details) : (row.details || {});
  const loc = row.suburb === 'ALL' ? row.city : `${row.suburb}, ${row.city}`;

  switch (row.risk_type) {
    case 'climate':
      return `${loc}. Climate: ${d.annual_rainfall_mm || '?'}mm/yr rainfall, ${d.avg_humidity || '?'}% humidity, damp risk ${d.damp_risk || '?'}, ${d.climate_zone || '?'}${d.frost_days_per_year ? ', ' + d.frost_days_per_year + ' frost days/yr' : ''}.`;

    case 'crime_detailed': {
      const cats = Array.isArray(d.categories) ? d.categories.slice(0, 5).map(c => `${c.type} (${c.count})`).join(', ') : '';
      return `${loc}. Crime: ${row.risk_level || '?'} risk (score ${row.risk_score || '?'}/10). Total ${d.total_latest || '?'} incidents. Top types: ${cats}. Station: ${d.station_name || '?'}.`;
    }

    case 'security_community':
      return `${loc}. Security coverage: ${row.risk_level || '?'}${d.companies ? ', ' + d.companies + ' companies' : ''}${d.cpf_activity ? ', CPF activity: ' + d.cpf_activity : ''}.`;

    case 'sold_prices':
      return `${loc}. Recent property sales: avg R${d.avg_price?.toLocaleString() || '?'}, median R${d.median_price?.toLocaleString() || '?'}${d.total_sales ? ' (' + d.total_sales + ' sales)' : ''}${d.avg_price_per_sqm ? ', R' + d.avg_price_per_sqm.toLocaleString() + '/m²' : ''}.`;

    case 'school_proximity':
      return `${loc}. Schools: score ${row.risk_score || '?'}/10, ${d.within_1km || 0} schools within 1km, ${d.total_found || 0} within 3km.`;

    case 'fibre_coverage': {
      const provs = Array.isArray(d.providers) ? d.providers.map(p => p.name || p.isp).join(', ') : (d.providers || '?');
      return `${loc}. Fibre coverage: ${row.risk_level || '?'} (${provs})${d.max_speed || d.max_speed_mbps ? ', up to ' + (d.max_speed || d.max_speed_mbps) + 'Mbps' : ''}.`;
    }

    case 'loadshedding':
      return `${loc}. Load shedding: ${row.risk_level || '?'} impact${d.group ? ', Group ' + d.group : ''}${d.area ? ' (' + d.area + ')' : ''}.`;

    case 'social_concerns': {
      const concerns = Array.isArray(d.concerns) ? d.concerns.slice(0, 3).join(', ') : (d.concerns || '');
      const positives = Array.isArray(d.positives) ? d.positives.slice(0, 3).join(', ') : (d.positives || '');
      return `${loc}. Area sentiment: ${row.risk_level || '?'}${concerns ? '. Concerns: ' + concerns : ''}${positives ? '. Positives: ' + positives : ''}.`;
    }

    case 'dolomite':
      return `${loc}. Dolomite risk: ${row.risk_level || d.risk_level || '?'}. Sinkhole formation possible — check for wall cracks, uneven floors, and foundation settlement.`;

    case 'water_quality':
      return `${loc}. Water quality: score ${row.risk_score || '?'}/10${d.blue_drop ? ' (Blue Drop: ' + d.blue_drop + ')' : ''}. Affects plumbing corrosion and pipe lifespan.`;

    case 'sewerage_quality':
      return `${loc}. Sewerage quality: score ${row.risk_score || '?'}/10${d.green_drop ? ' (Green Drop: ' + d.green_drop + ')' : ''}.`;

    case 'electricity':
      return `${loc}. Electricity: ${row.risk_level || '?'}${d.tariff ? ', tariff R' + d.tariff + '/kWh' : ''}${d.solar_potential ? ', solar potential: ' + d.solar_potential : ''}.`;

    case 'price_trends': {
      const parts = [`${loc}. Property price trends: ${row.risk_level || 'unknown'} market.`];
      if (d.internal_data?.avg_price) parts.push(`Avg asking R${d.internal_data.avg_price.toLocaleString()}, ${d.internal_data.total_listings} listings.`);
      if (d.internal_data?.price_per_sqm) parts.push(`R${d.internal_data.price_per_sqm.toLocaleString()}/m².`);
      if (d.regional_trend) parts.push(`Regional: ${d.regional_trend.yoy_pct}% YoY (${d.regional_trend.note || ''}).`);
      if (d.market_context?.key_factors) parts.push(`Market factors: ${d.market_context.key_factors.slice(0, 3).join('; ')}.`);
      return parts.join(' ');
    }

    default:
      return `${loc}. ${row.risk_type}: ${row.risk_level || row.risk_score || '?'}.`;
  }
}

async function seedLiveData() {
  console.log('[seed-live] Warming up embedding model...');
  await warmup();

  let total = 0;

  // ─── 1. Area risk data ──────────────────────────────────────────────
  console.log('\n[seed-live] Seeding area_risk_data...');
  const { rows: areaRows } = await pool.query(
    'SELECT id, suburb, city, risk_type, risk_level, risk_score, details FROM area_risk_data ORDER BY id'
  );

  for (const row of areaRows) {
    const text = formatAreaRisk(row);
    const metadata = {
      suburb: row.suburb === 'ALL' ? null : row.suburb,
      city: row.city,
      risk_type: row.risk_type,
      risk_level: row.risk_level,
      risk_score: row.risk_score,
    };

    await upsertChunk(text, metadata, 'live', 'area_risk_data', row.id, `live:area_risk_data:${row.id}`);
    total++;
    if (total % 50 === 0) console.log(`  [${total}] ...`);
  }
  console.log(`  Area risk: ${areaRows.length} chunks`);

  // ─── 2. Crime aggregates by suburb ──────────────────────────────────
  console.log('\n[seed-live] Seeding crime aggregates...');
  const { rows: crimeAgg } = await pool.query(
    `SELECT suburb, city,
            json_agg(json_build_object('type', incident_type, 'count', cnt) ORDER BY cnt DESC) AS types,
            SUM(cnt) AS total
     FROM (
       SELECT suburb, city, incident_type, COUNT(*) AS cnt
       FROM crime_incidents
       GROUP BY suburb, city, incident_type
     ) sub
     GROUP BY suburb, city
     ORDER BY suburb, city`
  );

  for (const row of crimeAgg) {
    const types = Array.isArray(row.types) ? row.types : JSON.parse(row.types);
    const topTypes = types.slice(0, 5).map(t => `${t.type} (${t.count})`).join(', ');
    const text = `${row.suburb}, ${row.city}. Crime incidents: ${row.total} total. Top types: ${topTypes}.`;
    const metadata = {
      suburb: row.suburb,
      city: row.city,
      total_incidents: Number(row.total),
      top_type: types[0]?.type,
    };

    await upsertChunk(text, metadata, 'crime', 'crime_incidents', null, `crime:${row.suburb}:${row.city}`);
    total++;
  }
  console.log(`  Crime: ${crimeAgg.length} suburb chunks`);

  // ─── 3. Security coverage by suburb ─────────────────────────────────
  console.log('\n[seed-live] Seeding security coverage...');
  const { rows: secAgg } = await pool.query(
    `SELECT ssc.suburb, ssc.city,
            COUNT(DISTINCT sc.id) AS company_count,
            COUNT(DISTINCT sc.id) FILTER (WHERE sc.armed_response = true) AS armed_count,
            json_agg(DISTINCT jsonb_build_object('name', sc.name, 'rating', sc.google_rating, 'armed', sc.armed_response)) AS companies
     FROM suburb_security_coverage ssc
     JOIN security_companies sc ON sc.id = ssc.security_company_id
     GROUP BY ssc.suburb, ssc.city
     ORDER BY ssc.suburb, ssc.city`
  );

  for (const row of secAgg) {
    const companies = Array.isArray(row.companies) ? row.companies : JSON.parse(row.companies);
    const companyList = companies.slice(0, 5).map(c =>
      `${c.name}${c.rating ? ' (' + c.rating + '★)' : ''}${c.armed ? ' [armed]' : ''}`
    ).join(', ');
    const text = `${row.suburb}, ${row.city}. Security: ${row.company_count} companies, ${row.armed_count} with armed response. Companies: ${companyList}.`;
    const metadata = {
      suburb: row.suburb,
      city: row.city,
      company_count: Number(row.company_count),
      armed_response_count: Number(row.armed_count),
    };

    await upsertChunk(text, metadata, 'security', 'suburb_security_coverage', null, `security:${row.suburb}:${row.city}`);
    total++;
  }
  console.log(`  Security: ${secAgg.length} suburb chunks`);

  // ─── 4. Properties (listings with descriptions) ─────────────────────
  console.log('\n[seed-live] Seeding properties...');
  const PROP_BATCH = 500;
  let propOffset = 0;
  let propCount = 0;

  while (true) {
    const { rows: props } = await pool.query(
      `SELECT id, suburb, city, province, property_type, construction_era, roof_material,
              bedrooms, bathrooms, asking_price, stand_size_sqm, floor_area_sqm,
              suburb_crime_score, LEFT(description, 1000) AS description
       FROM properties
       WHERE suburb IS NOT NULL
       ORDER BY id
       LIMIT $1 OFFSET $2`,
      [PROP_BATCH, propOffset]
    );
    if (props.length === 0) break;

    for (const p of props) {
      const parts = [`${p.suburb}, ${p.city || ''}.`];
      if (p.property_type) parts.push(`Type: ${p.property_type}.`);
      if (p.bedrooms) parts.push(`${p.bedrooms} bed, ${p.bathrooms || '?'} bath.`);
      if (p.asking_price) parts.push(`Asking R${p.asking_price.toLocaleString()}.`);
      if (p.stand_size_sqm) parts.push(`Stand ${p.stand_size_sqm}m².`);
      if (p.floor_area_sqm) parts.push(`Floor ${p.floor_area_sqm}m².`);
      if (p.construction_era) parts.push(`Era: ${p.construction_era}.`);
      if (p.roof_material) parts.push(`Roof: ${p.roof_material}.`);
      if (p.suburb_crime_score) parts.push(`Crime score: ${p.suburb_crime_score}/10.`);
      if (p.description && p.description.length > 50) parts.push(p.description.replace(/\s+/g, ' ').trim());

      const text = parts.join(' ');
      const metadata = {
        suburb: p.suburb,
        city: p.city,
        property_type: p.property_type,
        construction_era: p.construction_era,
        roof_material: p.roof_material,
        bedrooms: p.bedrooms,
        asking_price: p.asking_price,
      };

      await upsertChunk(text, metadata, 'property', 'properties', p.id, `property:${p.id}`);
      propCount++;
      total++;
    }

    propOffset += PROP_BATCH;
    console.log(`  [${propCount}] properties embedded...`);
  }
  console.log(`  Properties: ${propCount} chunks`);

  // ─── 5. Vision evidence (past findings) ─────────────────────────────
  console.log('\n[seed-live] Seeding vision evidence...');
  const { rows: evidence } = await pool.query(
    `SELECT he.id, he.category, he.observation, he.defect_or_risk, he.sa_context,
            he.what_i_see, he.what_it_means, he.confidence_tier, he.severity,
            he.cost_min_zar, he.cost_max_zar, he.kb_match_reason,
            p.suburb, p.city, p.construction_era, p.roof_material
     FROM holly_evidence he
     JOIN properties p ON p.id = he.property_id
     ORDER BY he.id`
  );

  for (const e of evidence) {
    const parts = [];
    if (e.suburb) parts.push(`${e.suburb}, ${e.city || ''}.`);
    parts.push(`Category: ${e.category}. Severity: ${e.severity}.`);
    if (e.what_i_see) parts.push(`Observed: ${e.what_i_see}`);
    if (e.defect_or_risk) parts.push(`Defect: ${e.defect_or_risk}.`);
    if (e.sa_context) parts.push(`SA context: ${e.sa_context}`);
    if (e.what_it_means) parts.push(`Meaning: ${e.what_it_means}`);
    if (e.cost_min_zar) parts.push(`Cost: R${e.cost_min_zar}–R${e.cost_max_zar}.`);

    const text = parts.join(' ');
    const metadata = {
      suburb: e.suburb,
      city: e.city,
      category: e.category,
      severity: e.severity,
      confidence_tier: e.confidence_tier,
      defect_or_risk: e.defect_or_risk,
      construction_era: e.construction_era,
      roof_material: e.roof_material,
    };

    await upsertChunk(text, metadata, 'evidence', 'holly_evidence', e.id, `evidence:${e.id}`);
    total++;
  }
  console.log(`  Evidence: ${evidence.length} chunks`);

  // ─── 5b. Vision analysis from property_images ──────────────────────
  console.log('\n[seed-live] Seeding vision analysis...');
  const { rows: visionImages } = await pool.query(
    `SELECT pi.id, pi.property_id,
            pi.vision_analysis->>'photo_type' AS photo_type,
            pi.vision_analysis->'findings' AS findings,
            p.suburb, p.city, p.construction_era, p.roof_material
     FROM property_images pi
     JOIN properties p ON p.id = pi.property_id
     WHERE pi.vision_analysis IS NOT NULL
       AND jsonb_typeof(pi.vision_analysis->'findings') = 'array'
       AND jsonb_array_length(pi.vision_analysis->'findings') > 0
     ORDER BY pi.id`
  );

  let visionCount = 0;
  for (const img of visionImages) {
    const findings = typeof img.findings === 'string' ? JSON.parse(img.findings) : (img.findings || []);
    const findingSummaries = findings.slice(0, 5).map(f => {
      const cat = f.category || 'unknown';
      const what = f.what_i_see || f.observation || '';
      const defect = f.defect_or_risk || '';
      return `[${cat}] ${defect}${what ? ': ' + what.substring(0, 100) : ''}`;
    });

    if (findingSummaries.length === 0) continue;

    const parts = [];
    if (img.suburb) parts.push(`${img.suburb}, ${img.city || ''}.`);
    parts.push(`Photo type: ${img.photo_type || 'unknown'}.`);
    if (img.construction_era) parts.push(`Era: ${img.construction_era}.`);
    if (img.roof_material) parts.push(`Roof: ${img.roof_material}.`);
    parts.push(`Findings: ${findingSummaries.join('; ')}`);

    const text = parts.join(' ');
    const metadata = {
      suburb: img.suburb,
      city: img.city,
      photo_type: img.photo_type,
      finding_count: findings.length,
      construction_era: img.construction_era,
      roof_material: img.roof_material,
    };

    await upsertChunk(text, metadata, 'vision', 'property_images', img.id, `vision:${img.id}`);
    visionCount++;
    total++;
  }
  console.log(`  Vision analysis: ${visionCount} chunks`);

  // ─── 5c. Security companies (individual records) ───────────────────
  console.log('\n[seed-live] Seeding security companies...');
  const { rows: companies } = await pool.query(
    `SELECT sc.id, sc.name, sc.province, sc.armed_response, sc.google_rating,
            sc.google_review_count, sc.psira_verified, sc.company_size,
            sc.services,
            (SELECT string_agg(DISTINCT ssc.suburb || ', ' || ssc.city, '; ')
             FROM suburb_security_coverage ssc WHERE ssc.security_company_id = sc.id
             LIMIT 1) AS coverage_areas
     FROM security_companies sc
     ORDER BY sc.id`
  );

  for (const c of companies) {
    const parts = [`${c.name}.`];
    if (c.province) parts.push(`Province: ${c.province}.`);
    if (c.armed_response) parts.push('Armed response available.');
    if (c.google_rating) parts.push(`Google: ${c.google_rating}★ (${c.google_review_count || 0} reviews).`);
    if (c.psira_verified) parts.push('PSIRA verified.');
    if (c.company_size) parts.push(`Size: ${c.company_size}.`);
    if (c.coverage_areas) parts.push(`Areas: ${c.coverage_areas}.`);
    const services = typeof c.services === 'string' ? JSON.parse(c.services || '[]') : (c.services || []);
    if (Array.isArray(services) && services.length > 0) parts.push(`Services: ${services.slice(0, 5).join(', ')}.`);

    const text = parts.join(' ');
    const metadata = {
      name: c.name,
      province: c.province,
      armed_response: c.armed_response,
      google_rating: c.google_rating,
      psira_verified: c.psira_verified,
    };

    await upsertChunk(text, metadata, 'security_company', 'security_companies', c.id, `security_company:${c.id}`);
    total++;
  }
  console.log(`  Security companies: ${companies.length} chunks`);

  // ─── 6. Property reports (decisions) ────────────────────────────────
  console.log('\n[seed-live] Seeding property reports...');
  const { rows: reports } = await pool.query(
    `SELECT pr.id, pr.decision, pr.decision_reasoning, pr.asbestos_risk,
            pr.insurance_risk_score, pr.crime_risk_score, pr.buyer_risk_index,
            pr.asking_price,
            p.suburb, p.city, p.construction_era, p.roof_material, p.property_type
     FROM property_reports pr
     JOIN properties p ON p.id = pr.property_id
     ORDER BY pr.id`
  );

  for (const r of reports) {
    // Skip broken/failed reports
    if (r.decision_reasoning && (r.decision_reasoning.includes('Pipeline failed') || r.decision_reasoning.includes('JSON at position'))) {
      console.log(`  [SKIP] Report ${r.id} — pipeline failure`);
      continue;
    }

    const parts = [];
    if (r.suburb) parts.push(`${r.suburb}, ${r.city || ''}.`);
    if (r.property_type) parts.push(`${r.property_type}.`);
    parts.push(`Decision: ${r.decision}.`);
    if (r.decision_reasoning) parts.push(`Reasoning: ${r.decision_reasoning}`);
    if (r.asbestos_risk) parts.push(`Asbestos risk: ${r.asbestos_risk}.`);
    if (r.insurance_risk_score) parts.push(`Insurance risk: ${r.insurance_risk_score}/10.`);
    if (r.buyer_risk_index) parts.push(`Buyer risk index: ${r.buyer_risk_index}.`);

    const text = parts.join(' ');
    const metadata = {
      suburb: r.suburb,
      city: r.city,
      decision: r.decision,
      asbestos_risk: r.asbestos_risk,
      construction_era: r.construction_era,
    };

    await upsertChunk(text, metadata, 'report', 'property_reports', r.id, `report:${r.id}`);
    total++;
  }
  console.log(`  Reports: ${reports.length} chunks`);

  // ─── 7. User feedback (corrections and confirmations) ───────────────
  console.log('\n[seed-live] Seeding user feedback...');
  const { rows: feedback } = await pool.query(
    `SELECT df.id, df.section, df.feedback, df.rating, df.finding_hash,
            df.context, p.suburb, p.city
     FROM data_feedback df
     LEFT JOIN properties p ON p.id = df.property_id
     ORDER BY df.id`
  );

  for (const f of feedback) {
    const ctx = typeof f.context === 'string' ? JSON.parse(f.context || '{}') : (f.context || {});
    const parts = [];
    if (f.suburb) parts.push(`${f.suburb}, ${f.city || ''}.`);
    parts.push(`Feedback on ${f.section}: ${f.rating}.`);
    if (ctx.observation) parts.push(`Finding: ${ctx.observation}`);
    if (f.feedback && f.feedback !== f.rating) parts.push(`Comment: ${f.feedback}`);

    const text = parts.join(' ');
    const metadata = {
      suburb: f.suburb,
      city: f.city,
      section: f.section,
      rating: f.rating,
    };

    await upsertChunk(text, metadata, 'feedback', 'data_feedback', f.id, `feedback:${f.id}`);
    total++;
  }
  console.log(`  Feedback: ${feedback.length} chunks`);

  console.log(`\n[seed-live] Done: ${total} total chunks embedded`);
}

seedLiveData()
  .then(() => pool.end())
  .catch(err => { console.error(err); pool.end(); process.exit(1); });
