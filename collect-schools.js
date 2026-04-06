/**
 * School Proximity Collector
 * Finds schools near a property using Google Places API and SA education data.
 * Schools are a top-3 factor in SA property values.
 */
const pool = require('./db');

const SCHOOL_TYPES = ['primary school', 'secondary school', 'high school'];
const SEARCH_RADIUS_M = 3000; // 3km

function postJSON(url, body, apiKey) {
  const https = require('https');
  const parsed = new (require('url').URL)(url);
  return new Promise((resolve) => {
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'places.displayName,places.location,places.rating,places.userRatingCount,places.formattedAddress,places.id',
      },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

/**
 * Find schools near a property using Google Places Nearby Search.
 */
async function collectForProperty(propertyId) {
  const { rows } = await pool.query('SELECT lat, lng, suburb, city FROM properties WHERE id = $1', [propertyId]);
  if (!rows[0]?.lat) return { error: 'not geocoded' };

  const { lat, lng, suburb, city } = rows[0];
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return { error: 'GOOGLE_MAPS_API_KEY not set' };

  const allSchools = [];

  for (const type of SCHOOL_TYPES) {
    // Use Places API (New) — Text Search
    const url = `https://places.googleapis.com/v1/places:searchText`;
    const body = JSON.stringify({
      textQuery: `${type} near ${suburb} ${city || ''}`,
      locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius: SEARCH_RADIUS_M } },
      maxResultCount: 10,
    });
    const data = await postJSON(url, body, apiKey);

    if (data?.places) {
      for (const place of data.places) {
        const plat = place.location?.latitude;
        const plng = place.location?.longitude;
        if (!plat) continue;
        const distance = haversineDistance(lat, lng, plat, plng);
        allSchools.push({
          name: place.displayName?.text || '',
          type: type.includes('primary') ? 'primary' : 'secondary',
          rating: place.rating || null,
          user_ratings_total: place.userRatingCount || 0,
          distance_m: Math.round(distance),
          distance_km: (distance / 1000).toFixed(1),
          address: place.formattedAddress || '',
          place_id: place.id || '',
        });
      }
    }
    await new Promise(r => setTimeout(r, 300));
  }

  // Deduplicate by place_id
  const seen = new Set();
  const unique = allSchools.filter(s => {
    if (seen.has(s.place_id)) return false;
    seen.add(s.place_id);
    return true;
  }).sort((a, b) => a.distance_m - b.distance_m);

  // Compute school score
  const within1km = unique.filter(s => s.distance_m <= 1000);
  const within2km = unique.filter(s => s.distance_m <= 2000);
  const highRated = unique.filter(s => s.rating >= 4.0);
  let schoolScore = 5; // baseline
  if (within1km.length >= 2) schoolScore += 2;
  else if (within2km.length >= 2) schoolScore += 1;
  if (highRated.length >= 1) schoolScore += 2;
  if (unique.length === 0) schoolScore = 2;
  schoolScore = Math.min(10, Math.max(1, schoolScore));

  // Store
  try {
    await pool.query(
      `INSERT INTO area_risk_data (suburb, city, risk_type, risk_level, risk_score, details, source_name, data_date)
       VALUES ($1, $2, 'school_proximity', $3, $4, $5, 'google_places', CURRENT_DATE)
       ON CONFLICT DO NOTHING`,
      [suburb, city, schoolScore >= 7 ? 'good' : schoolScore >= 4 ? 'moderate' : 'poor',
       schoolScore, JSON.stringify({ schools: unique.slice(0, 20), total_found: unique.length, within_1km: within1km.length, within_2km: within2km.length })]
    );
  } catch {}

  console.log(`[schools] ${suburb}: ${unique.length} schools found, ${within1km.length} within 1km, score ${schoolScore}/10`);
  return { school_score: schoolScore, total: unique.length, within_1km: within1km.length, schools: unique.slice(0, 10) };
}

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

module.exports = { collectForProperty };
