/**
 * Security & Community Intelligence for Properties
 *
 * Collects security company coverage, CPF info, neighbourhood watch data,
 * and community sentiment about safety for a property's area.
 *
 * Data sources (in priority order):
 * 1. Local DB — suburb_security_coverage, saps_precincts, neighbourhood_watches
 *    (populated by bootstrap scrapers: scrape-assist247, scrape-procompare, scrape-saps-stations)
 * 2. Google Places API (New) text search — fills gaps when DB has no coverage data
 *
 * All Google lookups use Google Places API (already configured, no new API keys needed).
 */

const https = require('https');
const pool = require('./db');
const { recordSource } = require('./provenance');

const SECURITY_KEYWORDS = [
  'armed response', 'response time', 'patrol', 'alarm',
  'break-in', 'break in', 'burglary', 'robbery', 'stolen',
  'safe', 'unsafe', 'secure', 'security',
  'crime', 'criminal', 'suspect',
  'cctv', 'camera', 'electric fence', 'boom gate',
  'cpf', 'community policing', 'neighbourhood watch', 'neighborhood watch',
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Google Places API text search (fallback) ────────────────────────

async function placesTextSearch(query, lat, lng, radius) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return [];

  const body = JSON.stringify({
    textQuery: query,
    locationBias: {
      circle: { center: { latitude: lat, longitude: lng }, radius: radius || 5000 }
    },
    maxResultCount: 10,
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'places.googleapis.com',
      path: '/v1/places:searchText',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.reviews,places.types,places.websiteUri,places.nationalPhoneNumber',
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          console.error(`[security] Places API ${res.statusCode}: ${data.substring(0, 200)}`);
          resolve([]);
          return;
        }
        try { resolve(JSON.parse(data).places || []); }
        catch { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.write(body);
    req.end();
  });
}

// ─── DB-first security company lookup ────────────────────────────────

async function getSecurityCompaniesFromDB(suburb, city) {
  const { rows } = await pool.query(
    `SELECT DISTINCT sc.name, sc.phone, sc.website, sc.google_rating AS rating,
            sc.google_review_count AS review_count, sc.armed_response, sc.psira_number,
            ssc.source, ssc.source_url
     FROM suburb_security_coverage ssc
     JOIN security_companies sc ON sc.id = ssc.security_company_id
     WHERE (ssc.suburb ILIKE $1 OR ssc.city ILIKE $1 OR ssc.suburb ILIKE $2 OR ssc.city ILIKE $2)
     ORDER BY sc.google_rating DESC NULLS LAST, sc.google_review_count DESC NULLS LAST`,
    [suburb, city]
  );

  return rows.map(r => ({
    name: r.name,
    phone: r.phone || null,
    website: r.website || null,
    rating: r.rating ? parseFloat(r.rating) : null,
    review_count: r.review_count || 0,
    armed_response: r.armed_response || false,
    psira_number: r.psira_number || null,
    source: r.source,
    top_reviews: [],
    complaints: [],
  }));
}

// ─── DB-first CPF lookup ─────────────────────────────────────────────

async function getCPFFromDB(suburb, city) {
  // Try suburb → precinct mapping first
  const { rows: mapping } = await pool.query(
    `SELECT sp.station_name, sp.phone, sp.email, sp.cpf_chair_name, sp.cpf_chair_phone,
            sp.cpf_facebook_url, sp.cpf_website_url, sp.cpf_activity_score,
            sp.lat, sp.lng
     FROM suburb_precinct_map spm
     JOIN saps_precincts sp ON sp.id = spm.saps_precinct_id
     WHERE spm.suburb ILIKE $1 OR spm.city ILIKE $2
     LIMIT 1`,
    [suburb, city]
  );

  if (mapping.length > 0) {
    const m = mapping[0];
    return {
      name: `${m.station_name} CPF`,
      station_name: m.station_name,
      contact_phone: m.cpf_chair_phone || m.phone || null,
      contact_email: m.email || null,
      facebook_url: m.cpf_facebook_url || null,
      website_url: m.cpf_website_url || null,
      activity_level: m.cpf_activity_score > 70 ? 'active' : m.cpf_activity_score > 30 ? 'moderate' : m.cpf_activity_score > 0 ? 'low' : 'unknown',
      evidence: `SAPS precinct: ${m.station_name}`,
      sources: [`SAPS ${m.station_name}`],
    };
  }

  // Fallback: try to find the nearest precinct by name match
  const { rows: nearest } = await pool.query(
    `SELECT station_name, phone, email, province
     FROM saps_precincts
     WHERE station_name ILIKE $1 OR station_name ILIKE $2
     LIMIT 1`,
    [`%${suburb}%`, `%${city}%`]
  );

  if (nearest.length > 0) {
    return {
      name: `${nearest[0].station_name} CPF`,
      station_name: nearest[0].station_name,
      contact_phone: nearest[0].phone || null,
      contact_email: nearest[0].email || null,
      facebook_url: null,
      website_url: null,
      activity_level: 'unknown',
      evidence: `SAPS precinct: ${nearest[0].station_name} (name match)`,
      sources: [`SAPS ${nearest[0].station_name}`],
    };
  }

  return null;
}

// ─── DB-first neighbourhood watch lookup ─────────────────────────────

async function getNHWFromDB(suburb, city) {
  const { rows } = await pool.query(
    `SELECT name, facebook_page_url, facebook_member_count, facebook_post_frequency,
            website_url, contact_phone, accredited, accrediting_body, activity_score, source
     FROM neighbourhood_watches
     WHERE suburb ILIKE $1 OR city ILIKE $2
     ORDER BY activity_score DESC NULLS LAST
     LIMIT 1`,
    [suburb, city]
  );

  if (rows.length > 0) {
    const r = rows[0];
    return {
      name: r.name,
      contact_info: r.contact_phone || null,
      facebook_url: r.facebook_page_url || null,
      website_url: r.website_url || null,
      accredited: r.accredited || false,
      accrediting_body: r.accrediting_body || null,
      member_count: r.facebook_member_count || null,
      activity_level: r.activity_score > 70 ? 'active' : r.activity_score > 30 ? 'moderate' : r.activity_score > 0 ? 'low' : 'unknown',
      sources: [r.source],
    };
  }

  return null;
}

// ─── Google Places fallback for security companies ───────────────────

async function searchSecurityCompaniesGoogle(lat, lng, suburb, city) {
  // Include suburb in query for locality-relevant results
  const places = await placesTextSearch(`security company armed response ${suburb || ''}`, lat, lng, 5000);

  try {
    const { logGoogle } = require('./costs');
    await logGoogle('google_places_text_search');
  } catch {}

  const suburbLower = (suburb || '').toLowerCase();
  const cityLower = (city || '').toLowerCase();

  return places.map(p => {
    const reviews = (p.reviews || []).map(r => ({
      text: r.text?.text || '',
      rating: r.rating,
      time: r.relativePublishTimeDescription,
    }));

    const allText = reviews.map(r => r.text).join(' ').toLowerCase();
    const armedResponse = allText.includes('armed response') || allText.includes('armed reaction') ||
      (p.displayName?.text || '').toLowerCase().includes('armed') ||
      allText.includes('patrol');

    // Check if this company is relevant to the property's area
    const addr = (p.formattedAddress || '').toLowerCase();
    const localRelevant = addr.includes(suburbLower) || addr.includes(cityLower) ||
      allText.includes(suburbLower) || allText.includes(cityLower);

    const positive = reviews
      .filter(r => r.rating >= 4 && r.text.length > 20)
      .slice(0, 3)
      .map(r => r.text.substring(0, 150));
    const negative = reviews
      .filter(r => r.rating <= 2 && r.text.length > 20)
      .slice(0, 3)
      .map(r => r.text.substring(0, 150));

    return {
      name: p.displayName?.text || 'Unknown',
      address: p.formattedAddress || null,
      rating: p.rating || null,
      review_count: p.userRatingCount || 0,
      phone: p.nationalPhoneNumber || null,
      website: p.websiteUri || null,
      armed_response: armedResponse,
      local_relevant: localRelevant,
      source: 'google_places',
      top_reviews: positive,
      complaints: negative,
    };
  })
  .filter(c => c.review_count > 0 || c.name.toLowerCase().includes('security'))
  .sort((a, b) => (b.local_relevant ? 1 : 0) - (a.local_relevant ? 1 : 0) || (b.rating || 0) - (a.rating || 0));
}

// ─── Google Places fallback for CPF ──────────────────────────────────

async function searchCPFGoogle(lat, lng, suburb, city) {
  // Search specifically for the suburb's CPF first
  const query = `"${suburb}" CPF community policing forum ${city || ''}`;
  const places = await placesTextSearch(query, lat, lng, 5000);

  try {
    const { logGoogle } = require('./costs');
    await logGoogle('google_places_text_search');
  } catch {}

  if (places.length === 0) {
    return {
      name: null, contact_phone: null, contact_email: null,
      facebook_url: null, website_url: null,
      activity_level: 'unknown',
      evidence: 'No CPF found via Places search',
      sources: [],
    };
  }

  const best = places[0];
  const reviews = (best.reviews || []).map(r => r.text?.text || '');
  const allText = reviews.join(' ').toLowerCase();

  let activityLevel = 'unknown';
  if (reviews.length >= 5) activityLevel = 'active';
  else if (reviews.length >= 2) activityLevel = 'moderate';
  else if (reviews.length >= 1) activityLevel = 'low';

  const activityIndicators = ['meeting', 'patrol', 'whatsapp group', 'monthly', 'weekly', 'active'];
  const evidence = activityIndicators.filter(kw => allText.includes(kw));

  let facebookUrl = null;
  const fbMatch = (best.websiteUri || '' + ' ' + allText).match(/(?:https?:\/\/)?(?:www\.)?facebook\.com\/[^\s"')]+/i);
  if (fbMatch) facebookUrl = fbMatch[0].startsWith('http') ? fbMatch[0] : 'https://' + fbMatch[0];

  return {
    name: best.displayName?.text || null,
    contact_phone: best.nationalPhoneNumber || null,
    contact_email: null,
    facebook_url: facebookUrl,
    website_url: best.websiteUri || null,
    activity_level: activityLevel,
    evidence: evidence.length > 0
      ? `Reviews mention: ${evidence.join(', ')}`
      : `${reviews.length} review(s) found`,
    sources: [best.formattedAddress].filter(Boolean),
  };
}

// ─── Google Places fallback for NHW ──────────────────────────────────

async function searchNHWGoogle(lat, lng, suburb, city) {
  const query = `"${suburb}" neighbourhood watch ${city || ''}`;
  const places = await placesTextSearch(query, lat, lng, 5000);

  try {
    const { logGoogle } = require('./costs');
    await logGoogle('google_places_text_search');
  } catch {}

  if (places.length === 0) {
    return {
      name: null, contact_info: null, facebook_url: null,
      activity_level: 'unknown', sources: [],
    };
  }

  const best = places[0];
  const reviews = (best.reviews || []).map(r => r.text?.text || '');
  const allText = reviews.join(' ').toLowerCase();

  let activityLevel = 'unknown';
  if (reviews.length >= 5) activityLevel = 'active';
  else if (reviews.length >= 2) activityLevel = 'moderate';
  else if (reviews.length >= 1) activityLevel = 'low';

  let facebookUrl = null;
  const fbMatch = (best.websiteUri || '' + ' ' + allText).match(/(?:https?:\/\/)?(?:www\.)?facebook\.com\/[^\s"')]+/i);
  if (fbMatch) facebookUrl = fbMatch[0].startsWith('http') ? fbMatch[0] : 'https://' + fbMatch[0];

  return {
    name: best.displayName?.text || null,
    contact_info: best.nationalPhoneNumber || null,
    facebook_url: facebookUrl,
    activity_level: activityLevel,
    sources: [best.formattedAddress].filter(Boolean),
  };
}

// ─── Sentiment extraction ─────────────────────────────────────────────

function extractSentiment(securityCompanies, cpf, nhw) {
  const themes = new Set();
  const positive = [];
  const negative = [];

  for (const co of securityCompanies) {
    const allReviews = [...(co.top_reviews || []), ...(co.complaints || [])].join(' ').toLowerCase();

    if (allReviews.includes('response time') || allReviews.includes('fast') || allReviews.includes('quick'))
      themes.add('response_times');
    if (allReviews.includes('break-in') || allReviews.includes('burglary') || allReviews.includes('robbery'))
      themes.add('break_ins');
    if (allReviews.includes('patrol') || allReviews.includes('visible'))
      themes.add('patrol_visibility');
    if (allReviews.includes('alarm') || allReviews.includes('cctv') || allReviews.includes('camera'))
      themes.add('surveillance');
    if (allReviews.includes('electric fence') || allReviews.includes('boom gate'))
      themes.add('access_control');

    if (co.top_reviews?.length > 0) positive.push(`${co.name}: ${co.top_reviews[0].substring(0, 100)}`);
    if (co.complaints?.length > 0) negative.push(`${co.name}: ${co.complaints[0].substring(0, 100)}`);
  }

  if (cpf.activity_level === 'active') positive.push('Active CPF in the area');
  else if (cpf.name && cpf.activity_level !== 'unknown') positive.push(`CPF present (${cpf.activity_level})`);

  if (nhw.activity_level === 'active') positive.push('Active neighbourhood watch');
  else if (nhw.name && nhw.activity_level !== 'unknown') positive.push(`Neighbourhood watch present (${nhw.activity_level})`);

  const companyCount = securityCompanies.length;
  const avgRating = companyCount > 0
    ? securityCompanies.reduce((s, c) => s + (c.rating || 0), 0) / companyCount
    : 0;
  const hasCPF = cpf.name && cpf.activity_level !== 'unknown';
  const hasNHW = nhw.name && nhw.activity_level !== 'unknown';

  let overall = 'MODERATE';
  if (companyCount >= 3 && avgRating >= 3.5 && (hasCPF || hasNHW)) overall = 'GOOD';
  else if (companyCount <= 1 && !hasCPF && !hasNHW) overall = 'POOR';

  return {
    themes: [...themes],
    positive: positive.slice(0, 5),
    negative: negative.slice(0, 5),
    overall,
  };
}

// ─── Main collector ──────────────────────────────────────��────────────

async function collectForProperty(propertyId) {
  const { rows } = await pool.query(
    'SELECT id, lat, lng, suburb, city, province FROM properties WHERE id = $1',
    [propertyId]
  );
  if (!rows.length) return null;

  const prop = rows[0];
  if (!prop.lat || !prop.lng) {
    console.log(`[security] No coordinates for property ${propertyId} — skipping`);
    return null;
  }

  const lat = parseFloat(prop.lat);
  const lng = parseFloat(prop.lng);
  const suburb = prop.suburb || prop.city || 'unknown';
  const city = prop.city || 'unknown';

  console.log(`[security] Collecting for ${suburb}, ${city} (${lat}, ${lng})`);

  // ── Security companies: DB first, Google fallback ──
  let securityCompanies = await getSecurityCompaniesFromDB(suburb, city);
  let securitySource = 'surepath_db';

  if (securityCompanies.length === 0) {
    console.log(`[security] No DB coverage for ${suburb} — falling back to Google Places`);
    securityCompanies = await searchSecurityCompaniesGoogle(lat, lng, suburb, city);
    securitySource = 'google_places';
    await sleep(500);
  } else {
    console.log(`[security] Found ${securityCompanies.length} companies from DB`);
  }

  // ── CPF: DB first, Google fallback ──
  let cpf = await getCPFFromDB(suburb, city);
  let cpfSource = 'surepath_db';

  if (!cpf) {
    console.log(`[security] No CPF in DB for ${suburb} — falling back to Google Places`);
    cpf = await searchCPFGoogle(lat, lng, suburb, city);
    cpfSource = 'google_places';
    await sleep(500);
  } else {
    console.log(`[security] CPF from DB: ${cpf.name} (${cpf.activity_level})`);
  }

  // ── Neighbourhood watch: DB first, Google fallback ──
  let nhw = await getNHWFromDB(suburb, city);
  let nhwSource = 'surepath_db';

  if (!nhw) {
    console.log(`[security] No NHW in DB for ${suburb} — falling back to Google Places`);
    nhw = await searchNHWGoogle(lat, lng, suburb, city);
    nhwSource = 'google_places';
  } else {
    console.log(`[security] NHW from DB: ${nhw.name} (${nhw.activity_level})`);
  }

  // Extract sentiment
  const sentiment = extractSentiment(securityCompanies, cpf, nhw);
  console.log(`[security] Sentiment: ${sentiment.overall}, themes: ${sentiment.themes.join(', ') || 'none'}`);

  // Determine risk level
  let riskLevel = 'MEDIUM';
  if (sentiment.overall === 'GOOD') riskLevel = 'LOW';
  else if (sentiment.overall === 'POOR') riskLevel = 'HIGH';

  // Store in area_risk_data
  const details = {
    security_companies: securityCompanies,
    cpf,
    neighbourhood_watch: nhw,
    sentiment,
    data_sources: {
      security: securitySource,
      cpf: cpfSource,
      nhw: nhwSource,
    },
    collected_at: new Date().toISOString(),
  };

  // Delete old security_community data for this area before inserting new
  await pool.query(
    `DELETE FROM area_risk_data WHERE risk_type = 'security_community' AND suburb ILIKE $1 AND city ILIKE $2`,
    [suburb, city]
  );

  await pool.query(
    `INSERT INTO area_risk_data (suburb, city, risk_type, risk_level, details, source_name, source_url)
     VALUES ($1, $2, 'security_community', $3, $4, 'Security & Community Intelligence', 'https://surepath.co.za/')`,
    [suburb, city, riskLevel, JSON.stringify(details)]
  );

  // Provenance
  await recordSource(propertyId, 'Security & Community Intelligence',
    'https://surepath.co.za/', 'scraped', ['security_community']);

  console.log(`[security] Done — ${securityCompanies.length} companies (${securitySource}), CPF: ${cpf.name ? 'yes' : 'no'} (${cpfSource}), NHW: ${nhw.name ? 'yes' : 'no'} (${nhwSource}), sentiment: ${sentiment.overall}`);

  return {
    security_companies_count: securityCompanies.length,
    cpf_found: !!cpf.name,
    nhw_found: !!nhw.name,
    sentiment_overall: sentiment.overall,
    risk_level: riskLevel,
  };
}

module.exports = { collectForProperty };
