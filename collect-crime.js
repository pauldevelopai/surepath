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

// ─── CrimeHub API caches ────────────────────────────────────────────────

let _precinctsCache = null;
let _precinctsCacheTime = 0;
let _hierarchyCache = null; // { provinces, districts, municipalities }
let _hierarchyCacheTime = 0;

async function getAllPrecincts() {
  if (_precinctsCache && Date.now() - _precinctsCacheTime < 86400000) return _precinctsCache;
  try {
    const data = await fetchJSON('https://crimehub.org/my-police-station/lookups/precincts');
    if (data.results) {
      _precinctsCache = data.results;
      _precinctsCacheTime = Date.now();
      return _precinctsCache;
    }
  } catch (e) {
    console.error('[crime] Failed to fetch precincts list:', e.message);
  }
  return [];
}

/**
 * Build the full CrimeHub hierarchy: Province → District → Municipality → Precincts.
 * Cached for 7 days. ~50 API calls to build, then instant lookups.
 */
async function getHierarchy() {
  if (_hierarchyCache && Date.now() - _hierarchyCacheTime < 7 * 86400000) return _hierarchyCache;

  console.log('[crime] Building CrimeHub hierarchy cache...');
  const hierarchy = { provinces: [], municipalities: [], precinctsByMuni: {} };

  const delay = (ms) => new Promise(r => setTimeout(r, ms));

  try {
    const provData = await fetchJSON('https://crimehub.org/lookups/provinces');
    hierarchy.provinces = provData.results || [];

    for (const prov of hierarchy.provinces) {
      await delay(300);
      const distData = await fetchJSON(`https://crimehub.org/lookups/districts?parents=${prov.id}`);
      const districts = distData.results || [];

      for (const dist of districts) {
        await delay(300);
        const muniData = await fetchJSON(`https://crimehub.org/lookups/municipalities?parents=${dist.id}`);
        const municipalities = muniData.results || [];

        for (const muni of municipalities) {
          hierarchy.municipalities.push({
            id: muni.id,
            name: muni.text,
            district: dist.text,
            province: prov.text,
          });

          await delay(300);
          // Fetch precincts for this municipality
          try {
            const precData = await fetchJSON(`https://crimehub.org/lookups/precincts?municipalities=${muni.id}`);
            hierarchy.precinctsByMuni[muni.id] = (precData.results || []).map(p => ({
              id: p.id,
              name: p.text,
              municipalityId: muni.id,
              municipality: muni.text,
            }));
          } catch {}
        }
      }
    }

    _hierarchyCache = hierarchy;
    _hierarchyCacheTime = Date.now();
    const totalPrecincts = Object.values(hierarchy.precinctsByMuni).reduce((s, arr) => s + arr.length, 0);
    console.log(`[crime] Hierarchy built: ${hierarchy.provinces.length} provinces, ${hierarchy.municipalities.length} municipalities, ${totalPrecincts} precincts`);
  } catch (e) {
    console.error('[crime] Hierarchy build failed:', e.message);
  }

  return hierarchy;
}

/**
 * Find the nearest police station using the CrimeHub geographic hierarchy.
 * This is the ULTIMATE FALLBACK — works for any SA location by navigating:
 * Province → District → Municipality → Precincts
 *
 * Matches the property's city/suburb against municipality names.
 */
async function findStationByHierarchy(suburb, city, province) {
  const hierarchy = await getHierarchy();
  if (!hierarchy.municipalities.length) return null;

  // Map common city names to their municipality name in CrimeHub
  const CITY_MUNI_MAP = {
    'cape town': 'city of cape town', 'johannesburg': 'city of johannesburg',
    'pretoria': 'city of tshwane', 'centurion': 'city of tshwane',
    'durban': 'ethekwini', 'port elizabeth': 'nelson mandela bay',
    'gqeberha': 'nelson mandela bay', 'bloemfontein': 'mangaung',
    'east london': 'buffalo city', 'ballito': 'kwadukuza',
    'dolphin coast': 'kwadukuza', 'umhlanga': 'ethekwini',
    'sandton': 'city of johannesburg', 'randburg': 'city of johannesburg',
    'midrand': 'city of johannesburg', 'benoni': 'ekurhuleni',
    'boksburg': 'ekurhuleni', 'germiston': 'ekurhuleni',
    'kempton park': 'ekurhuleni', 'springs': 'ekurhuleni',
    'alberton': 'ekurhuleni', 'edenvale': 'ekurhuleni',
    'roodepoort': 'city of johannesburg', 'krugersdorp': 'mogale city',
    'paarl': 'drakenstein', 'wellington': 'drakenstein',
    'stellenbosch': 'stellenbosch', 'somerset west': 'city of cape town',
    'hermanus': 'overstrand', 'george': 'george', 'knysna': 'knysna',
    'mossel bay': 'mossel bay', 'pietermaritzburg': 'msunduzi',
    'newcastle': 'newcastle', 'richards bay': 'umhlathuze',
    'polokwane': 'polokwane', 'nelspruit': 'mbombela',
    'mbombela': 'mbombela', 'rustenburg': 'rustenburg',
    'kimberley': 'sol plaatje', 'potchefstroom': 'tlokwe',
    'vanderbijlpark': 'emfuleni', 'vereeniging': 'emfuleni',
  };

  const searchTerms = [suburb, city].filter(Boolean).map(s => s.toLowerCase());
  const provLower = (province || '').toLowerCase();

  // Step 1: Check direct city-to-municipality mapping
  let bestMuni = null;
  for (const term of searchTerms) {
    const mappedMuni = CITY_MUNI_MAP[term];
    if (mappedMuni) {
      bestMuni = hierarchy.municipalities.find(m => m.name.toLowerCase() === mappedMuni);
      if (bestMuni) break;
    }
  }

  // Step 2: Fuzzy search municipality names
  if (!bestMuni) {
    for (const muni of hierarchy.municipalities) {
      const muniLower = muni.name.toLowerCase();
      const muniProvLower = muni.province.toLowerCase();

      // Filter by province if we know it
      if (provLower && !muniProvLower.includes(provLower) && !provLower.includes(muniProvLower)) continue;

      for (const term of searchTerms) {
        if (muniLower === term || muniLower.includes(term) || term.includes(muniLower)) {
          bestMuni = muni;
          break;
        }
      }
      if (bestMuni) break;

      // Check district name too
      const distLower = muni.district.toLowerCase();
      for (const term of searchTerms) {
        if (distLower.includes(term) || term.includes(distLower)) {
          bestMuni = muni;
          break;
        }
      }
      if (bestMuni) break;
    }
  }

  // Step 3: Province-level fallback — pick the METRO municipality (largest) not just first alphabetically
  if (!bestMuni && provLower) {
    const metroNames = ['city of cape town', 'city of johannesburg', 'city of tshwane',
      'ethekwini', 'ekurhuleni', 'nelson mandela bay', 'buffalo city', 'mangaung'];
    const provMunis = hierarchy.municipalities.filter(m =>
      m.province.toLowerCase().includes(provLower) || provLower.includes(m.province.toLowerCase()));
    bestMuni = provMunis.find(m => metroNames.includes(m.name.toLowerCase())) || provMunis[0];
  }

  if (!bestMuni) {
    console.log(`[crime] No municipality match found for ${suburb}, ${city}, ${province}`);
    return null;
  }

  // Step 3: Get precincts in this municipality
  const precincts = hierarchy.precinctsByMuni[bestMuni.id] || [];
  if (precincts.length === 0) {
    console.log(`[crime] No precincts found in ${bestMuni.name}`);
    return null;
  }

  // Step 4: Pick the best precinct (prefer one matching suburb/city name)
  let bestPrecinct = precincts[0]; // default: first
  for (const p of precincts) {
    const pLower = p.name.toLowerCase();
    for (const term of searchTerms) {
      if (pLower.includes(term) || term.includes(pLower)) {
        bestPrecinct = p;
        break;
      }
    }
  }

  console.log(`[crime] Hierarchy lookup: ${suburb}, ${city} → ${bestMuni.name} municipality → ${bestPrecinct.name} station`);

  // Step 5: Get the station UUID
  return findStationId(bestPrecinct.name);
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

    // Partial match — only if the precinct name is a close match (avoid "Umhlanga" matching "Langa")
    if (!match) {
      match = precincts.find(p => {
        const pName = p.text.toLowerCase();
        // Precinct name must be at least 70% of the search term length to avoid false partials
        return (pName.includes(searchTerm) || searchTerm.includes(pName)) && pName.length >= searchTerm.length * 0.7;
      });
    }

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

// Known suburb-to-station mappings for areas without their own police station
const SUBURB_STATION_MAP = {
  'ballito': 'kwadukuza',
  "shaka's rock": 'kwadukuza',
  'shakas rock': 'kwadukuza',
  'salt rock': 'umhlali',
  'zimbali': 'kwadukuza',
  'dolphin coast': 'kwadukuza',
  'simbithi': 'kwadukuza',
  'tinley manor': 'kwadukuza',
  'sheffield beach': 'umhlali',
  'compensation': 'kwadukuza',
  'nkwazi': 'kwadukuza',
  'willard beach': 'kwadukuza',
  'thompson bay': 'kwadukuza',
  'thompsons bay': 'kwadukuza',
  'dunkirk estate': 'kwadukuza',
  'seaward estate': 'kwadukuza',
  'bryanston': 'randburg',
  'lonehill': 'randburg',
  'fourways': 'douglasdale',
  'dainfern': 'douglasdale',
  'constantia': 'wynberg',
  'tokai': 'diep river',
  'newlands': 'claremont',
  'bishops court': 'wynberg',
  'kenilworth': 'claremont',
  'plumstead': 'diep river',
  'observatory': 'woodstock',
  'mowbray': 'woodstock',
  'rondebosch': 'rondebosch',
  'green point': 'sea point',
  'mouille point': 'sea point',
  'waterfront': 'sea point',
  'camps bay': 'camps bay',
  'bantry bay': 'sea point',
  'clifton': 'sea point',
  'hout bay': 'hout bay',
  'century city': 'milnerton',
  'blouberg': 'table view',
  'parklands': 'table view',
  'umhlanga': 'durban north',
  'la lucia': 'durban north',
  'morningside': 'berea',
  'waterfall': 'hillcrest',
  'kloof': 'hillcrest',
  'illovo': 'sandringham',
  'craighall': 'norwood',
  'parkhurst': 'norwood',
  'parktown north': 'norwood',
  'melville': 'brixton',
  'greenside': 'norwood',
  'emmarentia': 'linden',
  'northcliff': 'linden',
  'bedfordview': 'bedfordview',
  'sunninghill': 'sandton',
};

/**
 * Find the nearest police station for a given lat/lng using the precincts list.
 * Tries known mappings, then suburb/city/address parts.
 */
async function findNearestStation(suburb, city, addressParts) {
  // Try known suburb-to-station mappings first (exact and partial)
  const suburbLower = (suburb || '').toLowerCase();
  const cityLower = (city || '').toLowerCase();
  for (const [key, station] of Object.entries(SUBURB_STATION_MAP)) {
    if (suburbLower === key || suburbLower.includes(key) || key.includes(suburbLower) ||
        cityLower === key || cityLower.includes(key)) {
      const mapped = await findStationId(station);
      if (mapped) return mapped;
    }
  }

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
  const { rows } = await pool.query('SELECT id, suburb, city, province, address_raw, address_normalised FROM properties WHERE id = $1', [propertyId]);
  if (!rows.length) return null;

  const prop = rows[0];
  const suburb = prop.suburb || prop.city;
  if (!suburb) return { error: 'No suburb' };

  console.log(`[crime] Looking up station for: ${suburb}`);

  // Strategy 1: Direct suburb name match
  let station = await findStationId(suburb);

  // Strategy 2: Known mappings + address parts
  if (!station) {
    const addr = (prop.address_normalised || prop.address_raw || '').toLowerCase();
    const addressParts = addr.split(/[,\/]/).map(s => s.trim()).filter(s => s.length > 3 && s.length < 30);
    station = await findNearestStation(suburb, prop.city, addressParts);
  }

  // Strategy 3: CrimeHub geographic hierarchy (ULTIMATE FALLBACK)
  // Navigates Province → District → Municipality → Precincts
  if (!station) {
    console.log(`[crime] All name-based lookups failed for ${suburb} — trying hierarchy...`);
    station = await findStationByHierarchy(suburb, prop.city, prop.province);
  }

  if (!station) return { error: `No CrimeHub station found for ${suburb}. Try searching for the nearest police station at crimehub.org` };

  return collectWithStation(propertyId, prop, station);
}

async function collectWithStation(propertyId, prop, station) {
  console.log(`[crime] Found station: ${station.slug} (${station.id})`);

  const stats = await getStationStats(station.id);
  if (!stats) return { error: 'Could not fetch stats' };

  // Use suburb with city fallback (suburb may be null for some areas)
  const areaName = prop.suburb || prop.city;

  // Delete old crime data for this area
  await pool.query("DELETE FROM crime_incidents WHERE suburb ILIKE $1 AND city ILIKE $2 AND source = 'crimehub'", [areaName, prop.city]);

  // Store latest year data as crime_incidents
  const latestYear = stats.latest_year;
  let totalInserted = 0;

  for (const cat of stats.categories) {
    if (cat.latest > 0) {
      await pool.query(
        `INSERT INTO crime_incidents (suburb, city, incident_type, incident_date, source)
         VALUES ($1, $2, $3, $4, 'crimehub')`,
        [areaName, prop.city, cat.title.toLowerCase().replace(/\s+/g, '_'), `${latestYear}-06-15`]
      );

      // Store count as multiple records or as area_risk_data
      totalInserted++;
    }
  }

  // Store detailed stats in area_risk_data
  await pool.query("DELETE FROM area_risk_data WHERE suburb ILIKE $1 AND city ILIKE $2 AND risk_type = 'crime_detailed'", [areaName, prop.city]);
  await pool.query(
    `INSERT INTO area_risk_data (suburb, city, risk_type, risk_score, details, source_name, source_url, data_date)
     VALUES ($1, $2, 'crime_detailed', $3, $4, 'CrimeHub (ISS/SAPS)', $5, $6)`,
    [
      areaName, prop.city,
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

module.exports = { collectForProperty, findStationId, findStationByHierarchy, getStationStats };
