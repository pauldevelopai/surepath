/**
 * Collect REAL crime data from CrimeHub (ISS)
 *
 * Source: crimehub.org — Institute for Security Studies
 * Data: SAPS official crime statistics per police station, 2006-2025
 * Coverage: All 1,162 police stations in South Africa
 * Cost: Free
 *
 * Flow:
 * 1. Given a suburb name, find the nearest police station page on CrimeHub
 * 2. Extract the station UUID from the page
 * 3. Call the JSON stats API to get 20 years of crime data by category
 * 4. Store in the database with provenance
 */

const https = require('https');
const pool = require('./db');
const { recordSource } = require('./provenance');

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchJSON(res.headers.location.startsWith('http') ? res.headers.location : `https://crimehub.org${res.headers.location}`).then(resolve).catch(reject);
      }
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
        try { resolve(JSON.parse(body)); } catch { resolve(body); }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

function fetchHTML(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchHTML(res.headers.location.startsWith('http') ? res.headers.location : `https://crimehub.org${res.headers.location}`).then(resolve).catch(reject);
      }
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve(body));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// Cache the full precincts list (1,190 stations)
let _precinctsCache = null;
let _precinctsCacheTime = 0;

async function getAllPrecincts() {
  // Cache for 24 hours
  if (_precinctsCache && Date.now() - _precinctsCacheTime < 86400000) return _precinctsCache;

  try {
    const data = await fetchJSON('https://crimehub.org/my-police-station/lookups/precincts');
    if (data.results) {
      _precinctsCache = data.results; // [{ id, text, file_id }]
      _precinctsCacheTime = Date.now();
      return _precinctsCache;
    }
  } catch (e) {
    console.error('[crime] Failed to fetch precincts list:', e.message);
  }
  return [];
}

/**
 * Find the CrimeHub station UUID for a suburb/area name.
 * Uses multiple strategies:
 * 1. Direct slug match on CrimeHub page
 * 2. Search the precincts API for fuzzy name match
 * 3. Try nearby/related station names
 */
async function findStationId(stationName) {
  const slug = stationName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  // Strategy 1: Direct page fetch (fastest if it works)
  try {
    const html = await fetchHTML(`https://crimehub.org/my-police-station/${slug}`);
    const match = html.match(/stats\/([a-f0-9-]{36})/);
    if (match) return { id: match[1], slug, url: `https://crimehub.org/my-police-station/${slug}` };
  } catch {}

  // Strategy 2: Search the precincts API for a matching name
  const precincts = await getAllPrecincts();
  if (precincts.length > 0) {
    const searchTerm = stationName.toLowerCase().replace(/[^a-z\s]/g, '').trim();

    // Exact name match
    let match = precincts.find(p => p.text.toLowerCase() === searchTerm);

    // Partial match (precinct name contains suburb or vice versa)
    if (!match) match = precincts.find(p => p.text.toLowerCase().includes(searchTerm) || searchTerm.includes(p.text.toLowerCase()));

    // Word-level match (any word in the suburb matches a precinct name)
    if (!match) {
      const words = searchTerm.split(/\s+/).filter(w => w.length > 3);
      for (const word of words) {
        match = precincts.find(p => p.text.toLowerCase() === word);
        if (match) break;
      }
    }

    if (match) {
      // Fetch the station page to get the stats UUID
      const matchSlug = match.text.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      try {
        const html = await fetchHTML(`https://crimehub.org/my-police-station/${matchSlug}`);
        const m = html.match(/stats\/([a-f0-9-]{36})/);
        if (m) return { id: m[1], slug: matchSlug, url: `https://crimehub.org/my-police-station/${matchSlug}` };
      } catch {}

      // Try by ID endpoint
      try {
        const html = await fetchHTML(`https://crimehub.org/my-police-station/id/${match.id}`);
        const m = html.match(/stats\/([a-f0-9-]{36})/);
        if (m) {
          const pageSlug = html.match(/my-police-station\/([a-z0-9-]+)/)?.[1] || matchSlug;
          return { id: m[1], slug: pageSlug, url: `https://crimehub.org/my-police-station/${pageSlug}` };
        }
      } catch {}
    }
  }

  return null;
}

/**
 * Find the nearest police station for a given lat/lng using the precincts list.
 * Tries common nearby suburb/area names from the geocoded address.
 */
async function findNearestStation(suburb, city, addressParts) {
  const candidates = new Set();

  // Add the suburb and city
  if (suburb) candidates.add(suburb);
  if (city) candidates.add(city);

  // Add address parts (split by comma)
  for (const part of addressParts) {
    const clean = part.trim();
    if (clean.length > 3 && clean.length < 30) candidates.add(clean);
  }

  // Try each candidate
  for (const name of candidates) {
    const station = await findStationId(name);
    if (station) return station;

    // Try without common suburb suffixes
    const cleaned = name.replace(/(central|north|south|east|west|park|heights|estate|village|glen|view|ridge)$/i, '').trim();
    if (cleaned !== name && cleaned.length > 3) {
      const station2 = await findStationId(cleaned);
      if (station2) return station2;
    }
  }

  return null;
}

/**
 * Get full crime statistics for a station by UUID.
 */
async function getStationStats(stationId) {
  const data = await fetchJSON(`https://crimehub.org/my-police-station/stats/${stationId}`);
  if (!data.status) return null;

  const years = data.chart?.top?.data?.labels || [];
  const totalPerYear = data.chart?.top?.data?.datasets?.[1]?.data || [];
  const ratePerYear = data.chart?.top?.data?.datasets?.[0]?.data || [];

  return {
    categories: data.ranking.map(r => ({
      title: r.title,
      latest: r.stats[r.stats.length - 1], // last element = most recent year
      stats: r.stats,
    })),
    years,
    total_per_year: totalPerYear.map(Number),
    rate_per_100k: ratePerYear.map(v => v ? Number(v) : null),
    latest_year: years[years.length - 1],
    latest_total: Number(totalPerYear[totalPerYear.length - 1]),
  };
}

/**
 * Collect crime data for a property.
 */
async function collectForProperty(propertyId) {
  const { rows } = await pool.query('SELECT id, suburb, city, address_raw, address_normalised FROM properties WHERE id = $1', [propertyId]);
  if (!rows.length) return null;

  const prop = rows[0];
  const suburb = prop.suburb || prop.city;
  if (!suburb) return { error: 'No suburb' };

  console.log(`[crime] Looking up station for: ${suburb}`);

  // Try suburb first
  let station = await findStationId(suburb);

  if (!station) {
    // Use the full address to find nearby stations
    const addr = (prop.address_normalised || prop.address_raw || '').toLowerCase();
    const addressParts = addr.split(/[,\/]/).map(s => s.trim()).filter(s => s.length > 3 && s.length < 30);
    station = await findNearestStation(suburb, prop.city, addressParts);

    if (!station) return { error: `No CrimeHub station found for ${suburb}. Try searching for the nearest police station at crimehub.org` };
  }

  return collectWithStation(propertyId, prop, station);
}

async function collectWithStation(propertyId, prop, station) {
  console.log(`[crime] Found station: ${station.slug} (${station.id})`);

  const stats = await getStationStats(station.id);
  if (!stats) return { error: 'Could not fetch stats' };

  // Delete old crime data for this suburb
  await pool.query("DELETE FROM crime_incidents WHERE suburb ILIKE $1 AND city ILIKE $2 AND source = 'crimehub'", [prop.suburb, prop.city]);

  // Store latest year data as crime_incidents
  const latestYear = stats.latest_year;
  let totalInserted = 0;

  for (const cat of stats.categories) {
    if (cat.latest > 0) {
      await pool.query(
        `INSERT INTO crime_incidents (suburb, city, incident_type, incident_date, source)
         VALUES ($1, $2, $3, $4, 'crimehub')`,
        [prop.suburb, prop.city, cat.title.toLowerCase().replace(/\s+/g, '_'), `${latestYear}-06-15`]
      );

      // Store count as multiple records or as area_risk_data
      totalInserted++;
    }
  }

  // Store detailed stats in area_risk_data
  await pool.query("DELETE FROM area_risk_data WHERE suburb ILIKE $1 AND city ILIKE $2 AND risk_type = 'crime_detailed'", [prop.suburb, prop.city]);
  await pool.query(
    `INSERT INTO area_risk_data (suburb, city, risk_type, risk_score, details, source_name, source_url, data_date)
     VALUES ($1, $2, 'crime_detailed', $3, $4, 'CrimeHub (ISS/SAPS)', $5, $6)`,
    [
      prop.suburb, prop.city,
      Math.min(10, Math.round(stats.latest_total / 500)),
      JSON.stringify({
        station_name: station.slug.replace(/-/g, ' '),
        station_url: station.url,
        latest_year: latestYear,
        total_latest: stats.latest_total,
        categories: stats.categories.map(c => ({ type: c.title, count: c.latest })),
        trend_5yr: stats.total_per_year.slice(-5),
        trend_years: stats.years.slice(-5),
        rate_per_100k: stats.rate_per_100k[stats.rate_per_100k.length - 1],
      }),
      station.url,
      `${latestYear}-03-31`,
    ]
  );

  // Record provenance
  await recordSource(propertyId, 'CrimeHub (ISS/SAPS)', station.url, 'verified', ['suburb_crime_score']);

  // Update property crime score
  const score = Math.min(10, Math.round(stats.latest_total / 500));
  await pool.query('UPDATE properties SET suburb_crime_score = $1 WHERE id = $2', [score, propertyId]);

  const latest = stats.categories.slice(0, 5).map(c => `${c.title}: ${c.latest}`).join(', ');
  console.log(`[crime] ${station.slug}: ${stats.latest_total} total incidents (${latestYear}). Top: ${latest}`);

  return {
    station: station.slug,
    station_url: station.url,
    year: latestYear,
    total: stats.latest_total,
    categories: stats.categories,
    trend: stats.total_per_year.slice(-5),
  };
}

module.exports = { collectForProperty, findStationId, getStationStats };
