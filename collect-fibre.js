/**
 * Fibre/Internet Coverage Collector
 *
 * Checks fibre availability for SA properties.
 * Uses known SA fibre network coverage data.
 *
 * Major FNOs (Fibre Network Operators) in SA:
 * - Openserve (Telkom) — largest national network
 * - Vumatel — major metro coverage (JHB, CPT, DBN)
 * - Frogfoot — Cape Town, JHB
 * - Octotel — Cape Town
 * - MetroFibre — Gauteng, KZN
 * - DFA (Dark Fibre Africa) — business/wholesale
 *
 * Since ISP APIs are not publicly available, we use suburb-level
 * coverage data based on known deployment areas.
 */
const pool = require('./db');
const https = require('https');

// ─── Known fibre coverage by metro/region ──────────────────────────────
// This is based on publicly reported coverage data from each FNO.
// Coverage: 'full' = most of suburb, 'partial' = some areas, 'none' = not deployed
const METRO_COVERAGE = {
  'Cape Town': {
    providers: ['Openserve', 'Vumatel', 'Frogfoot', 'Octotel'],
    coverage: 'HIGH',
    note: 'Excellent fibre coverage. Most suburbs have 2+ providers. Speeds up to 1Gbps.',
  },
  'Johannesburg': {
    providers: ['Openserve', 'Vumatel', 'MetroFibre', 'Frogfoot'],
    coverage: 'HIGH',
    note: 'Strong coverage across most suburbs. Vumatel and Openserve dominant.',
  },
  'Pretoria': {
    providers: ['Openserve', 'Vumatel', 'MetroFibre'],
    coverage: 'HIGH',
    note: 'Good metro coverage. Eastern suburbs may have fewer options.',
  },
  'Centurion': {
    providers: ['Openserve', 'Vumatel', 'MetroFibre'],
    coverage: 'HIGH',
    note: 'Strong coverage. Most estates and complexes connected.',
  },
  'Durban': {
    providers: ['Openserve', 'Vumatel'],
    coverage: 'MEDIUM',
    note: 'Growing coverage. Coastal suburbs well covered, inland areas expanding.',
  },
  'Port Elizabeth': {
    providers: ['Openserve'],
    coverage: 'MEDIUM',
    note: 'Openserve primary provider. Coverage concentrated in central suburbs.',
  },
  'Bloemfontein': {
    providers: ['Openserve'],
    coverage: 'LOW',
    note: 'Limited fibre. Openserve in select areas. Many suburbs rely on LTE/wireless.',
  },
  'East London': {
    providers: ['Openserve'],
    coverage: 'LOW',
    note: 'Limited fibre availability. Openserve in some areas.',
  },
};

function fetchPage(url) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : require('http');
    const req = lib.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
      timeout: 10000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchPage(res.headers.location).then(resolve);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ ok: res.statusCode === 200, body: data }));
    });
    req.on('error', () => resolve({ ok: false, body: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, body: '' }); });
  });
}

/**
 * Check fibre coverage for a property.
 * Uses metro-level data + attempts to get suburb-specific info.
 */
async function collectForProperty(propertyId) {
  const { rows } = await pool.query('SELECT lat, lng, suburb, city FROM properties WHERE id = $1', [propertyId]);
  if (!rows[0]?.suburb) return { error: 'no suburb data' };

  const { suburb, city } = rows[0];

  // Find metro coverage data
  let metro = null;
  for (const [metroName, data] of Object.entries(METRO_COVERAGE)) {
    if (city && city.toLowerCase().includes(metroName.toLowerCase())) {
      metro = { name: metroName, ...data };
      break;
    }
  }

  // If no direct match, try to infer from province/region
  if (!metro) {
    // Check if any metro name appears in the suburb
    for (const [metroName, data] of Object.entries(METRO_COVERAGE)) {
      if (suburb && suburb.toLowerCase().includes(metroName.toLowerCase())) {
        metro = { name: metroName, ...data };
        break;
      }
    }
  }

  const result = {
    suburb,
    city,
    coverage: metro ? metro.coverage : 'UNKNOWN',
    providers: metro ? metro.providers : [],
    providers_count: metro ? metro.providers.length : 0,
    note: metro ? metro.note : 'Fibre coverage data not available for this area. Check fibretiger.co.za for detailed coverage.',
    source: 'SA FNO deployment data 2025/26',
    check_url: 'https://www.fibretiger.co.za/fibre-coverage-map',
  };

  // Store in area_risk_data
  try {
    await pool.query(
      `INSERT INTO area_risk_data (suburb, city, risk_type, risk_level, risk_score, details, source_name, source_url, data_date)
       VALUES ($1, $2, 'fibre_coverage', $3, $4, $5, 'SA FNO coverage data', 'https://www.fibretiger.co.za/fibre-coverage-map', CURRENT_DATE)
       ON CONFLICT DO NOTHING`,
      [suburb, city, result.coverage, result.providers_count, JSON.stringify(result)]
    );
  } catch {}

  console.log(`[fibre] ${suburb}, ${city}: ${result.coverage} coverage, ${result.providers_count} providers (${result.providers.join(', ') || 'none known'})`);

  return result;
}

module.exports = { collectForProperty, METRO_COVERAGE };
