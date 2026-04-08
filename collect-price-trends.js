/**
 * SA Property Price Trends Collector
 *
 * Builds suburb-level price trend data by scraping:
 * 1. Property24 property values page — historical avg prices, recent sales
 * 2. Lightstone-style suburb profiles (via Property24's data partner pages)
 * 3. Our own internal data — price distributions from scraped listings
 *
 * Stores detailed trend data in area_risk_data with risk_type='price_trends'.
 * This feeds into RAG so Nico can explain why prices are rising/falling.
 */
const pool = require('./db');

function fetchHTML(url) {
  const https = require('https');
  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-ZA,en;q=0.9',
      },
      timeout: 20000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchHTML(res.headers.location).then(resolve);
      }
      if (res.statusCode !== 200) { resolve(null); return; }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function parsePrice(str) {
  if (!str) return null;
  const cleaned = str.replace(/[R\s,]/g, '');
  const num = parseInt(cleaned);
  return isNaN(num) ? null : num;
}

/**
 * Scrape Property24 property values page for suburb trends.
 */
async function scrapeP24Trends(suburb, city) {
  const suburbSlug = suburb.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const citySlug = (city || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');

  const url = `https://www.property24.com/property-values/${suburbSlug}/${citySlug}`;
  const html = await fetchHTML(url);
  if (!html) return null;

  const result = { source: 'property24', suburb, city };

  // Extract average property value
  const avgMatch = html.match(/Average\s+(?:Property\s+)?(?:Value|Price)[^R]*R\s*([\d,.\s]+)/i);
  if (avgMatch) result.avg_value = parsePrice(avgMatch[1]);

  // Extract median
  const medMatch = html.match(/Median\s+(?:Property\s+)?(?:Value|Price)[^R]*R\s*([\d,.\s]+)/i);
  if (medMatch) result.median_value = parsePrice(medMatch[1]);

  // Extract price per sqm
  const sqmMatch = html.match(/(?:Price|Value)\s+per\s+(?:sq|m)[^R]*R\s*([\d,.\s]+)/i);
  if (sqmMatch) result.price_per_sqm = parsePrice(sqmMatch[1]);

  // Extract year-on-year change
  const yoyMatch = html.match(/([-+]?\d+\.?\d*)%\s*(?:year|annual|yoy|change)/i);
  if (yoyMatch) result.yoy_change_pct = parseFloat(yoyMatch[1]);

  // Extract recent sales from listing cards
  const salesRegex = /R\s*([\d,.\s]+)[\s\S]{0,200}?(\d+)\s*(?:bed|bedroom)/gi;
  const sales = [];
  let match;
  while ((match = salesRegex.exec(html)) !== null && sales.length < 20) {
    const price = parsePrice(match[1]);
    const beds = parseInt(match[2]);
    if (price && price > 100000 && price < 100000000) {
      sales.push({ price, bedrooms: beds });
    }
  }
  if (sales.length > 0) result.recent_sales = sales;

  return result;
}

/**
 * Build internal price trends from our own property database.
 */
async function buildInternalTrends(suburb, city) {
  const { rows: listings } = await pool.query(`
    SELECT asking_price, bedrooms, property_type, floor_area_sqm, created_at
    FROM properties
    WHERE suburb ILIKE $1 AND city ILIKE $2 AND asking_price > 0
    ORDER BY created_at DESC
  `, [suburb, city]);

  if (listings.length === 0) return null;

  const prices = listings.map(l => l.asking_price);
  const avg = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
  const sorted = [...prices].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const min = sorted[0];
  const max = sorted[sorted.length - 1];

  // Price per sqm from listings that have floor area
  const withArea = listings.filter(l => l.floor_area_sqm > 0);
  const avgPricePerSqm = withArea.length > 0
    ? Math.round(withArea.reduce((s, l) => s + l.asking_price / l.floor_area_sqm, 0) / withArea.length)
    : null;

  // Price distribution by bedrooms
  const byBeds = {};
  for (const l of listings) {
    const beds = l.bedrooms || 'unknown';
    if (!byBeds[beds]) byBeds[beds] = [];
    byBeds[beds].push(l.asking_price);
  }
  const priceByBedrooms = {};
  for (const [beds, bedPrices] of Object.entries(byBeds)) {
    const bp = bedPrices.sort((a, b) => a - b);
    priceByBedrooms[beds] = {
      count: bp.length,
      avg: Math.round(bp.reduce((a, b) => a + b, 0) / bp.length),
      median: bp[Math.floor(bp.length / 2)],
      min: bp[0],
      max: bp[bp.length - 1],
    };
  }

  // Property type mix
  const typeCounts = {};
  for (const l of listings) {
    const t = l.property_type || 'unknown';
    typeCounts[t] = (typeCounts[t] || 0) + 1;
  }

  return {
    source: 'internal_listings',
    total_listings: listings.length,
    avg_price: avg,
    median_price: median,
    min_price: min,
    max_price: max,
    price_per_sqm: avgPricePerSqm,
    price_range: `R${min.toLocaleString()} – R${max.toLocaleString()}`,
    price_by_bedrooms: priceByBedrooms,
    property_type_mix: typeCounts,
  };
}

/**
 * SA macro market context — hardcoded current indicators.
 * Updated periodically. These provide context for Nico's analysis.
 */
function getMarketContext() {
  return {
    prime_rate: 11.50,
    repo_rate: 8.00,
    cpi_inflation: 3.2,
    house_price_inflation_national: 3.8, // FNB House Price Index YoY March 2025
    market_sentiment: 'cautiously_optimistic',
    key_factors: [
      'Interest rate cuts expected H2 2025 — will boost affordability',
      'GNU stability improving investor confidence',
      'Semigration from Gauteng to Western Cape/KZN continues',
      'Load shedding reduction positive for property values',
      'R350 SRD grant uncertainty affects lower-end market',
      'Construction costs rising 6-8% YoY — new builds getting expensive',
    ],
    regional_trends: {
      western_cape: { trend: 'strong_growth', yoy_pct: 5.2, note: 'Semigration demand, limited supply' },
      kwazulu_natal: { trend: 'moderate_growth', yoy_pct: 3.8, note: 'North coast and Umhlanga strong' },
      gauteng: { trend: 'flat', yoy_pct: 1.2, note: 'Oversupply in some areas, crime concerns' },
      eastern_cape: { trend: 'moderate_growth', yoy_pct: 3.0, note: 'Affordable market, remote work migrants' },
      free_state: { trend: 'flat', yoy_pct: 0.5, note: 'Limited demand outside Bloemfontein' },
      limpopo: { trend: 'flat', yoy_pct: 0.8, note: 'Small formal market' },
      mpumalanga: { trend: 'moderate_growth', yoy_pct: 2.5, note: 'White River/Mbombela growth' },
      north_west: { trend: 'flat', yoy_pct: 1.0, note: 'Mining town dependency' },
      northern_cape: { trend: 'flat', yoy_pct: 0.3, note: 'Very small market' },
    },
    affordability: {
      avg_household_income_monthly: 25000,
      max_affordable_bond: 1800000, // at prime+0.25%, 30% DTI
      first_time_buyer_pct: 35,
      avg_deposit_pct: 10,
    },
  };
}

/**
 * Collect price trends for a property's suburb.
 */
async function collectForProperty(propertyId) {
  const { rows } = await pool.query(
    'SELECT suburb, city, province FROM properties WHERE id = $1', [propertyId]
  );
  if (!rows[0]?.suburb) return { error: 'no suburb' };

  const { suburb, city, province } = rows[0];

  // Scrape P24 trends
  const p24 = await scrapeP24Trends(suburb, city);

  // Build internal trends from our DB
  const internal = await buildInternalTrends(suburb, city);

  // Get macro context
  const market = getMarketContext();

  // Determine provincial trend
  const provKey = (province || '').toLowerCase().replace(/\s+/g, '_');
  const regionalTrend = market.regional_trends[provKey] || null;

  const result = {
    suburb,
    city,
    province,
    p24_data: p24,
    internal_data: internal,
    regional_trend: regionalTrend,
    market_context: {
      prime_rate: market.prime_rate,
      house_price_inflation: market.house_price_inflation_national,
      market_sentiment: market.market_sentiment,
      key_factors: market.key_factors,
    },
    affordability: market.affordability,
    collected_at: new Date().toISOString(),
  };

  // Store in area_risk_data
  const riskScore = regionalTrend
    ? Math.round(regionalTrend.yoy_pct > 4 ? 8 : regionalTrend.yoy_pct > 2 ? 6 : regionalTrend.yoy_pct > 0 ? 5 : 3)
    : 5;

  try {
    await pool.query(
      `INSERT INTO area_risk_data (suburb, city, risk_type, risk_level, risk_score, details, source_name, data_date)
       VALUES ($1, $2, 'price_trends', $3, $4, $5, 'property24 + internal', CURRENT_DATE)
       ON CONFLICT DO NOTHING`,
      [suburb, city,
       regionalTrend?.trend || 'unknown',
       riskScore,
       JSON.stringify(result)]
    );
  } catch (e) { console.error(`[trends] DB insert failed for ${suburb}:`, e.message); }

  const avgPrice = internal?.avg_price || p24?.avg_value || 0;
  console.log(`[trends] ${suburb}, ${city}: avg R${avgPrice.toLocaleString()}, ${internal?.total_listings || 0} listings, ${regionalTrend?.trend || '?'} (${regionalTrend?.yoy_pct || '?'}% YoY)`);

  return result;
}

module.exports = { collectForProperty, getMarketContext };
