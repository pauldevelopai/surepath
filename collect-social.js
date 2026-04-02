/**
 * Social Listening for Properties
 *
 * Collects nearby reviews, news, and complaints for a property location.
 *
 * Data sources:
 * 1. Google Places API (New) — reviews from nearby businesses mentioning noise, traffic, safety
 * 2. Google News — articles about the area (flooding, crime, development)
 *
 * Scans reviews for keywords: noise, loud, traffic, parking, unsafe, crime,
 * flood, damp, building, construction, smell, pollution, loadshedding
 */

const https = require('https');
const pool = require('./db');
const { recordSource } = require('./provenance');

const CONCERN_KEYWORDS = [
  'noise', 'noisy', 'loud', 'music', 'party',
  'traffic', 'parking', 'congestion', 'busy road',
  'unsafe', 'crime', 'robbery', 'stolen', 'break-in', 'mugging',
  'flood', 'flooding', 'damp', 'leak', 'water damage',
  'construction', 'building site', 'development',
  'smell', 'sewage', 'pollution', 'dump',
  'loadshedding', 'load shedding', 'power cut', 'blackout',
];

/**
 * Search Google Places (New) for nearby places and extract reviews.
 */
async function getNearbyReviews(lat, lng, radius) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return [];

  const body = JSON.stringify({
    includedTypes: ['restaurant', 'school', 'shopping_mall', 'bar', 'night_club', 'gas_station',
      'supermarket', 'park', 'gym', 'hospital', 'bank', 'cafe', 'lodging'],
    maxResultCount: 20,
    locationRestriction: {
      circle: { center: { latitude: lat, longitude: lng }, radius: radius || 1000 }
    }
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'places.googleapis.com',
      path: '/v1/places:searchNearby',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': 'places.displayName,places.types,places.rating,places.userRatingCount,places.reviews,places.formattedAddress',
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(new Error(`Places API ${res.statusCode}: ${data.substring(0, 200)}`)); return; }
        try { resolve(JSON.parse(data).places || []); }
        catch { reject(new Error('Invalid JSON from Places API')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Words that indicate the review is about the BUSINESS itself, not the area.
 * We filter these out — a hotel's broken faucet tells us nothing about living here.
 */
const IRRELEVANT_PATTERNS = [
  // Hotel/accommodation complaints (about the hotel, not the area)
  /\b(room service|check.?in|check.?out|reception|concierge|housekeeping|minibar|breakfast buffet|hotel staff|front desk)\b/i,
  /\b(bed was|pillow|towel|shower|bathroom was|aircon|wifi|internet|tv|channel|mattress)\b/i,
  /\b(booking|reservation|refund|overcharged|bill was|invoice|management)\b/i,
  // Restaurant/food complaints (about the food, not the area)
  /\b(waiter|waitress|portion|menu|dish was|food was cold|order was wrong|chef|kitchen)\b/i,
  // Shopping complaints
  /\b(cashier|shelf|stock|price was|expensive|checkout queue)\b/i,
];

/**
 * Check if a review is about AREA concerns (relevant to residents)
 * vs business-specific complaints (irrelevant to property buyers).
 */
function isAreaRelevant(text, keywords) {
  // If the review mentions area-level concerns (crime, flood, construction, loadshedding)
  // these are always relevant regardless of context
  const areaKeywords = ['unsafe', 'crime', 'robbery', 'stolen', 'break-in', 'mugging',
    'flood', 'flooding', 'water damage', 'construction', 'building site',
    'sewage', 'pollution', 'dump', 'loadshedding', 'load shedding', 'power cut', 'blackout'];

  if (keywords.some(kw => areaKeywords.includes(kw))) return true;

  // For noise/traffic/parking, check the review isn't about the business itself
  if (IRRELEVANT_PATTERNS.some(pat => pat.test(text))) return false;

  // Noise at a night club or bar is expected — only flag if it's about the AREA being noisy
  return true;
}

/**
 * Scan reviews for concern keywords.
 * Only keeps concerns relevant to living in the area — filters out
 * business-specific complaints (hotel rooms, food quality, etc.).
 */
function scanReviews(places) {
  const concerns = [];
  const positives = [];

  // Skip place types that generate irrelevant reviews
  const skipTypes = new Set(['lodging', 'hotel', 'motel', 'hostel', 'resort_hotel']);

  for (const place of places) {
    if (!place.reviews) continue;

    // Hotels/lodging reviews are almost always about the hotel, not the area
    const placeTypes = new Set(place.types || []);
    const isLodging = [...skipTypes].some(t => placeTypes.has(t));

    for (const review of place.reviews) {
      const text = (review.text?.text || '').toLowerCase();
      if (text.length < 10) continue;

      const matched = CONCERN_KEYWORDS.filter(kw => text.includes(kw));
      if (matched.length > 0 && isAreaRelevant(text, matched)) {
        // For lodging, only keep reviews about area-level issues (crime, noise from outside)
        if (isLodging) {
          const areaOnly = matched.filter(kw =>
            ['unsafe', 'crime', 'robbery', 'stolen', 'break-in', 'mugging',
             'flood', 'loadshedding', 'load shedding', 'power cut'].includes(kw));
          if (areaOnly.length === 0) continue;
        }

        concerns.push({
          place: place.displayName?.text,
          place_address: place.formattedAddress,
          review_text: review.text.text.substring(0, 300),
          rating: review.rating,
          keywords: matched,
          author: review.authorAttribution?.displayName,
          time: review.relativePublishTimeDescription,
        });
      }

      // Capture positive reviews about the AREA (safe, quiet, family-friendly)
      if (review.rating >= 4 && (text.includes('safe') || text.includes('quiet') || text.includes('peaceful') || text.includes('family') || text.includes('beautiful area') || text.includes('great neighbourhood') || text.includes('great neighborhood'))) {
        positives.push({
          place: place.displayName?.text,
          review_text: review.text.text.substring(0, 200),
          rating: review.rating,
        });
      }
    }
  }

  return { concerns, positives };
}

/**
 * Collect social intelligence for a property.
 */
async function collectForProperty(propertyId) {
  const { rows } = await pool.query('SELECT id, lat, lng, suburb, city FROM properties WHERE id = $1', [propertyId]);
  if (!rows.length || !rows[0].lat) return null;

  const prop = rows[0];
  const lat = parseFloat(prop.lat);
  const lng = parseFloat(prop.lng);

  console.log(`[social] Collecting for property ${propertyId} at ${lat}, ${lng}`);

  // Get nearby places with reviews
  const places = await getNearbyReviews(lat, lng, 1000);
  console.log(`[social] Found ${places.length} nearby places`);

  const { concerns, positives } = scanReviews(places);
  console.log(`[social] ${concerns.length} concerns, ${positives.length} positives`);

  // Store in area_risk_data
  if (concerns.length > 0) {
    await pool.query(
      `INSERT INTO area_risk_data (suburb, city, risk_type, risk_level, details, source_name, source_url)
       VALUES ($1, $2, 'social_concerns', $3, $4, 'Google Places Reviews', 'https://maps.google.com/')`,
      [
        prop.suburb || 'unknown', prop.city || 'unknown',
        concerns.length >= 5 ? 'HIGH' : concerns.length >= 2 ? 'MEDIUM' : 'LOW',
        JSON.stringify({ concerns: concerns.slice(0, 20), positives: positives.slice(0, 10), places_scanned: places.length }),
      ]
    );
  }

  // Log cost
  try {
    const { logGoogle } = require('./costs');
    await logGoogle('google_places_nearby', propertyId);
    // Places reviews cost extra
    for (let i = 0; i < Math.min(places.length, 20); i++) {
      await logGoogle('google_places_details', propertyId);
    }
  } catch {}

  return {
    places_scanned: places.length,
    concerns,
    positives,
    summary: {
      total_reviews_scanned: places.reduce((s, p) => s + (p.reviews?.length || 0), 0),
      noise_mentions: concerns.filter(c => c.keywords.some(k => ['noise', 'noisy', 'loud', 'music', 'party'].includes(k))).length,
      traffic_mentions: concerns.filter(c => c.keywords.some(k => ['traffic', 'parking', 'congestion'].includes(k))).length,
      safety_mentions: concerns.filter(c => c.keywords.some(k => ['unsafe', 'crime', 'robbery', 'stolen', 'break-in'].includes(k))).length,
      flood_mentions: concerns.filter(c => c.keywords.some(k => ['flood', 'flooding', 'damp', 'leak'].includes(k))).length,
    },
  };
}

module.exports = { collectForProperty, getNearbyReviews, scanReviews };
