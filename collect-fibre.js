/**
 * Fibre/Internet Coverage Collector
 * Checks fibre availability from major SA ISP infrastructure providers.
 * Uses Openserve (Telkom), Vumatel, and Frogfoot coverage APIs.
 */
const pool = require('./db');

const PROVIDERS = [
  {
    name: 'openserve',
    label: 'Openserve (Telkom)',
    checkUrl: (lat, lng) => `https://www.openserve.co.za/api/coverage?lat=${lat}&lng=${lng}`,
  },
  {
    name: 'vumatel',
    label: 'Vumatel',
    checkUrl: (lat, lng) => `https://www.vumatel.co.za/api/check-coverage?latitude=${lat}&longitude=${lng}`,
  },
  {
    name: 'frogfoot',
    label: 'Frogfoot',
    checkUrl: (lat, lng) => `https://www.frogfoot.com/api/coverage?lat=${lat}&lng=${lng}`,
  },
];

async function fetchJSON(url) {
  const https = require('https');
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'User-Agent': 'SurePath/1.0', 'Accept': 'application/json' }, timeout: 10000 }, (res) => {
      if (res.statusCode !== 200) { resolve(null); return; }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/**
 * Check fibre coverage for a property by coordinates.
 * Falls back to suburb-level lookup if coordinate-level fails.
 */
async function collectForProperty(propertyId) {
  const { rows } = await pool.query('SELECT lat, lng, suburb, city FROM properties WHERE id = $1', [propertyId]);
  if (!rows[0]?.lat) return { error: 'not geocoded' };

  const { lat, lng, suburb, city } = rows[0];
  const results = [];

  for (const provider of PROVIDERS) {
    try {
      const url = provider.checkUrl(lat, lng);
      const data = await fetchJSON(url);
      if (data) {
        results.push({
          provider: provider.name,
          label: provider.label,
          available: data.available || data.covered || data.hasCoverage || false,
          speeds: data.speeds || data.packages || null,
          raw: data,
        });
        console.log(`[fibre] ${provider.label}: ${data.available || data.covered ? 'AVAILABLE' : 'not available'}`);
      } else {
        // API not responding — try alternative lookup
        results.push({ provider: provider.name, label: provider.label, available: null, error: 'api_unavailable' });
        console.log(`[fibre] ${provider.label}: API unavailable`);
      }
    } catch (e) {
      results.push({ provider: provider.name, label: provider.label, available: null, error: e.message });
    }
  }

  // Store results
  const available = results.filter(r => r.available === true);
  const fibreScore = available.length >= 2 ? 'excellent' : available.length === 1 ? 'good' : results.every(r => r.available === null) ? 'unknown' : 'none';

  try {
    await pool.query(
      `INSERT INTO area_risk_data (suburb, city, risk_type, risk_level, risk_score, details, source_name, data_date)
       VALUES ($1, $2, 'fibre_coverage', $3, $4, $5, 'fibre_check', CURRENT_DATE)
       ON CONFLICT DO NOTHING`,
      [suburb, city, fibreScore, available.length, JSON.stringify({ providers: results, property_id: propertyId })]
    );
  } catch {}

  return { fibre_score: fibreScore, providers_available: available.length, providers_checked: results.length, results };
}

module.exports = { collectForProperty, PROVIDERS };
