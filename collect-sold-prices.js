/**
 * Neighbourhood Sold Price Collector
 * Scrapes recent sold/transfer prices from Property24's sold section
 * for comparable sales in the same suburb. Critical for AVM accuracy.
 */
const pool = require('./db');

function fetchHTML(url) {
  const https = require('https');
  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html',
      },
      timeout: 15000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchHTML(res.headers.location).then(resolve);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/**
 * Extract sold prices from Property24 sold listings page for a suburb.
 */
async function collectForProperty(propertyId) {
  const { rows } = await pool.query('SELECT suburb, city, province, bedrooms, property_type FROM properties WHERE id = $1', [propertyId]);
  if (!rows[0]?.suburb) return { error: 'no suburb' };

  const { suburb, city, bedrooms } = rows[0];
  const suburbSlug = suburb.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const citySlug = (city || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');

  // Try Property24 sold listings
  const url = `https://www.property24.com/property-values/${suburbSlug}/${citySlug}`;
  console.log(`[sold-prices] Fetching: ${url}`);

  const html = await fetchHTML(url);
  if (!html) return { error: 'fetch failed' };

  // Extract price data from the page
  const sales = [];

  // Look for JSON-LD structured data
  const jsonLdMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g);
  if (jsonLdMatch) {
    for (const match of jsonLdMatch) {
      try {
        const json = JSON.parse(match.replace(/<\/?script[^>]*>/g, ''));
        if (json['@type'] === 'ItemList' && json.itemListElement) {
          for (const item of json.itemListElement) {
            if (item.item?.offers?.price) {
              sales.push({
                address: item.item.name || '',
                price: parseInt(item.item.offers.price),
                date: item.item.datePosted || null,
                bedrooms: null,
                source: 'property24_jsonld',
              });
            }
          }
        }
      } catch {}
    }
  }

  // Fallback: extract from HTML patterns
  if (sales.length === 0) {
    // Look for price patterns in the page: R 1,200,000 or R1200000
    const pricePattern = /R\s?([\d,\s]+)\s*(?:000)?/g;
    const addressPattern = /class="[^"]*listing[^"]*"[^>]*>[\s\S]*?<[^>]*>([^<]+)</g;
    // Simple extraction — this is a best-effort scrape
    let match;
    while ((match = pricePattern.exec(html)) !== null) {
      const price = parseInt(match[1].replace(/[,\s]/g, ''));
      if (price >= 100000 && price <= 50000000) {
        sales.push({ address: suburb, price, date: null, source: 'property24_html' });
      }
    }
  }

  // Deduplicate and sort
  const uniqueSales = sales.filter((s, i, arr) => arr.findIndex(x => x.price === s.price && x.address === s.address) === i)
    .sort((a, b) => b.price - a.price)
    .slice(0, 20);

  // Fallback: try ooba.co.za property prices page for suburb stats
  if (uniqueSales.length === 0) {
    console.log(`[sold-prices] P24 no data, trying ooba.co.za...`);
    try {
      const oobaUrl = `https://www.ooba.co.za/resources/property-prices/${citySlug}/`;
      const oobaHtml = await fetchHTML(oobaUrl);
      if (oobaHtml && oobaHtml.length > 1000) {
        // ooba publishes city-level stats: average price, median, growth %
        const avgMatch = oobaHtml.match(/average.*?(?:price|value).*?R\s?([\d,.\s]+)/i);
        const medMatch = oobaHtml.match(/median.*?(?:price|value).*?R\s?([\d,.\s]+)/i);
        if (avgMatch || medMatch) {
          const avgPrice = avgMatch ? parseInt(avgMatch[1].replace(/[,.\s]/g, '')) : null;
          const medPrice = medMatch ? parseInt(medMatch[1].replace(/[,.\s]/g, '')) : null;
          if (avgPrice || medPrice) {
            const oobaResult = { suburb, city, sales_count: 0, avg_price: avgPrice, median_price: medPrice || avgPrice, min_price: null, max_price: null, sales: [], source: 'ooba.co.za' };
            try {
              await pool.query(
                `INSERT INTO area_risk_data (suburb, city, risk_type, risk_level, risk_score, details, source_name, source_url, data_date)
                 VALUES ($1, $2, 'sold_prices', 'info', 0, $3, 'ooba.co.za', $4, CURRENT_DATE) ON CONFLICT DO NOTHING`,
                [suburb, city, JSON.stringify(oobaResult), oobaUrl]
              );
            } catch (e) { console.error(`[sold-prices] ooba DB insert failed:`, e.message); }
            console.log(`[sold-prices] ooba: ${city} avg R${(avgPrice || 0).toLocaleString()}, median R${(medPrice || 0).toLocaleString()}`);
            return oobaResult;
          }
        }
      }
    } catch {}

    console.log(`[sold-prices] No sales data found for ${suburb}`);
    return { error: 'no data', suburb };
  }

  // Calculate stats
  const prices = uniqueSales.map(s => s.price).filter(p => p > 0);
  const avg = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
  const median = prices.sort((a, b) => a - b)[Math.floor(prices.length / 2)];
  const min = Math.min(...prices);
  const max = Math.max(...prices);

  const result = {
    suburb,
    city,
    sales_count: uniqueSales.length,
    avg_price: avg,
    median_price: median,
    min_price: min,
    max_price: max,
    sales: uniqueSales,
  };

  // Store
  try {
    await pool.query(
      `INSERT INTO area_risk_data (suburb, city, risk_type, risk_level, risk_score, details, source_name, data_date)
       VALUES ($1, $2, 'sold_prices', 'info', $3, $4, 'property24_values', CURRENT_DATE)
       ON CONFLICT DO NOTHING`,
      [suburb, city, uniqueSales.length, JSON.stringify(result)]
    );
  } catch (e) { console.error(`[sold-prices] DB insert failed for ${suburb}:`, e.message); }

  console.log(`[sold-prices] ${suburb}: ${uniqueSales.length} sales, avg R${avg.toLocaleString()}, median R${median.toLocaleString()}`);
  return result;
}

module.exports = { collectForProperty };
