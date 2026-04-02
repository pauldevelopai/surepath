#!/usr/bin/env node
/**
 * COLLECT SERVICE PROVIDERS
 *
 * Scrapes trade professional directories to build a database of
 * plumbers, electricians, painters, roofers etc. per suburb.
 *
 * Sources:
 * - Kandua.com — vetted professionals, ratings
 * - Snupit.co.za — marketplace, reviews
 * - FindATradesman.co.za — builder directory
 *
 * Usage:
 *   node bootstrap/collect-service-providers.js --city "Cape Town"
 *   node bootstrap/collect-service-providers.js --trade plumber --city "Johannesburg"
 *   node bootstrap/collect-service-providers.js --all
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const puppeteer = require('puppeteer');
const pool = require('../db');

const TRADES = ['plumber', 'electrician', 'painter', 'roofer', 'builder', 'locksmith', 'pest-control'];
const CITIES = [
  { name: 'Cape Town', slug: 'cape-town' },
  { name: 'Johannesburg', slug: 'johannesburg' },
  { name: 'Pretoria', slug: 'pretoria' },
  { name: 'Durban', slug: 'durban' },
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Scrape Kandua ─────────────────────────────────────────────────────

async function scrapeKandua(page, trade, city) {
  const url = `https://kandua.com/${trade}/${city.slug}`;
  console.log(`  Kandua: ${url}`);

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(2000);

    const providers = await page.evaluate(() => {
      const found = [];
      document.querySelectorAll('[class*="pro-card"], [class*="provider"], [class*="listing"]').forEach(el => {
        const name = el.querySelector('h2, h3, [class*="name"]')?.textContent?.trim();
        const rating = el.querySelector('[class*="rating"], [class*="score"]')?.textContent?.trim();
        const reviews = el.querySelector('[class*="review"]')?.textContent?.match(/(\d+)/)?.[1];
        if (name && name.length > 2) {
          found.push({ name, rating: rating ? parseFloat(rating) : null, reviews: reviews ? parseInt(reviews) : null });
        }
      });
      return found;
    });

    return providers.map(p => ({ ...p, source: 'Kandua', source_url: url }));
  } catch (err) {
    console.log(`    Error: ${err.message}`);
    return [];
  }
}

// ─── Scrape Snupit ─────────────────────────────────────────────────────

async function scrapeSnupit(page, trade, city) {
  const tradeSlug = trade + 's';
  const url = `https://www.snupit.co.za/${city.slug}/${tradeSlug}`;
  console.log(`  Snupit: ${url}`);

  try {
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 25000 });
    await sleep(3000);

    // Parse from the page text — Snupit has a consistent format:
    // Provider Name\nSuburb, City\nDescription...\nRating\nN reviews
    const providers = await page.evaluate(() => {
      const found = [];
      const text = document.body.innerText;

      // Split by "Request a Quote" which separates each provider
      const sections = text.split('Request a Quote');

      for (const section of sections) {
        const lines = section.trim().split('\n').map(l => l.trim()).filter(Boolean);

        // Look for pattern: Name, then Suburb + City, then rating + reviews
        // The provider name is typically a line with proper capitalisation before the suburb line
        let name = null;
        let suburb = null;
        let rating = null;
        let reviews = null;

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];

          // Suburb line contains "Cape Town" or "Johannesburg" etc
          if (line.includes(', Cape Town') || line.includes(', Johannesburg') || line.includes(', Durban') || line.includes(', Pretoria')) {
            suburb = line;
            // Name is the line before the suburb
            if (i > 0 && lines[i - 1].length > 3 && lines[i - 1].length < 60) {
              name = lines[i - 1];
            }
          }

          // Rating line — just a number like "4.7" or "5"
          const ratingMatch = line.match(/^([\d.]+)$/);
          if (ratingMatch && parseFloat(ratingMatch[1]) <= 5) {
            rating = parseFloat(ratingMatch[1]);
          }

          // Reviews line
          const reviewMatch = line.match(/^(\d+)\s+reviews?/i);
          if (reviewMatch) reviews = parseInt(reviewMatch[1]);
        }

        if (name && name.length > 3 && !found.some(f => f.name === name)) {
          found.push({ name, suburb, rating, reviews });
        }
      }

      return found;
    });

    return providers.map(p => ({
      ...p,
      source: 'Snupit',
      source_url: url,
    }));
  } catch (err) {
    console.log(`    Error: ${err.message}`);
    return [];
  }
}

// ─── Store providers ───────────────────────────────────────────────────

async function storeProvider(provider, trade, city) {
  // Skip if already exists
  const { rows } = await pool.query(
    'SELECT id FROM service_providers WHERE name = $1 AND trade = $2 AND city = $3',
    [provider.name, trade, city.name]
  );
  if (rows.length > 0) return false;

  await pool.query(
    `INSERT INTO service_providers (name, trade, city, phone, rating, review_count, source_name, source_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [provider.name, trade, city.name, provider.phone, provider.rating, provider.reviews, provider.source, provider.source_url]
  );
  return true;
}

// ─── Main ──────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const cityFilter = args.includes('--city') ? args[args.indexOf('--city') + 1] : null;
  const tradeFilter = args.includes('--trade') ? args[args.indexOf('--trade') + 1] : null;

  const cities = cityFilter ? CITIES.filter(c => c.name.toLowerCase().includes(cityFilter.toLowerCase())) : CITIES;
  const trades = tradeFilter ? [tradeFilter] : TRADES;

  console.log(`Collecting service providers: ${trades.length} trades × ${cities.length} cities\n`);

  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');

  let totalStored = 0;

  for (const city of cities) {
    for (const trade of trades) {
      console.log(`\n${trade} in ${city.name}:`);

      const kanduaProviders = await scrapeKandua(page, trade, city);
      const snupitProviders = await scrapeSnupit(page, trade, city);

      const all = [...kanduaProviders, ...snupitProviders];
      let stored = 0;

      for (const p of all) {
        const isNew = await storeProvider(p, trade, city);
        if (isNew) stored++;
      }

      console.log(`  Found: ${all.length}, Stored: ${stored}`);
      totalStored += stored;

      await sleep(3000);
    }
  }

  await browser.close();

  const { rows: stats } = await pool.query(`
    SELECT trade, city, COUNT(*) AS cnt
    FROM service_providers GROUP BY trade, city ORDER BY city, trade
  `);
  console.log('\n=== SERVICE PROVIDERS SUMMARY ===');
  for (const s of stats) console.log(`  ${s.city} — ${s.trade}: ${s.cnt}`);

  const { rows: total } = await pool.query('SELECT COUNT(*) AS c FROM service_providers');
  console.log(`\nTotal: ${total[0].c} service providers`);

  await pool.end();
}

main().catch(err => { console.error(err); pool.end(); process.exit(1); });
