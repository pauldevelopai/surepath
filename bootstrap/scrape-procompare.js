#!/usr/bin/env node
/**
 * PROCOMPARE SECURITY COMPANY SCRAPER
 *
 * Scrapes procompare.co.za for security company listings per city.
 * Procompare has 42+ city pages with top-rated security companies,
 * including reviews and ratings.
 *
 * Usage:
 *   node bootstrap/scrape-procompare.js                         # Scrape all cities
 *   node bootstrap/scrape-procompare.js --delay 3               # Seconds between requests
 *   node bootstrap/scrape-procompare.js --max 10                # Limit cities to process
 *   node bootstrap/scrape-procompare.js --status                # Show DB stats only
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const https = require('https');
const http = require('http');
const pool = require('../db');

const BASE_URL = 'https://www.procompare.co.za';
const INDEX_URL = `${BASE_URL}/security-companies`;
const DEFAULT_DELAY_SEC = 3;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ─── Fetch a page ────────────────────────────────────────────────────

function fetchPage(url) {
  const mod = url.startsWith('https') ? https : http;
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    };
    mod.get(url, options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, url).href;
        return fetchPage(redirectUrl).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve(body));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ─── Known cities with their province mappings ───────────────────────

const CITIES = [
  { slug: 'alberton', name: 'Alberton', city: 'Ekurhuleni', province: 'Gauteng' },
  { slug: 'benoni', name: 'Benoni', city: 'Ekurhuleni', province: 'Gauteng' },
  { slug: 'bloemfontein', name: 'Bloemfontein', city: 'Bloemfontein', province: 'Free State' },
  { slug: 'boksburg', name: 'Boksburg', city: 'Ekurhuleni', province: 'Gauteng' },
  { slug: 'cape-town', name: 'Cape Town', city: 'Cape Town', province: 'Western Cape' },
  { slug: 'centurion', name: 'Centurion', city: 'Pretoria', province: 'Gauteng' },
  { slug: 'durban', name: 'Durban', city: 'Durban', province: 'KwaZulu-Natal' },
  { slug: 'east-london', name: 'East London', city: 'East London', province: 'Eastern Cape' },
  { slug: 'edenvale', name: 'Edenvale', city: 'Ekurhuleni', province: 'Gauteng' },
  { slug: 'germiston', name: 'Germiston', city: 'Ekurhuleni', province: 'Gauteng' },
  { slug: 'johannesburg', name: 'Johannesburg', city: 'Johannesburg', province: 'Gauteng' },
  { slug: 'kempton-park', name: 'Kempton Park', city: 'Ekurhuleni', province: 'Gauteng' },
  { slug: 'klerksdorp', name: 'Klerksdorp', city: 'Klerksdorp', province: 'North West' },
  { slug: 'krugersdorp', name: 'Krugersdorp', city: 'Krugersdorp', province: 'Gauteng' },
  { slug: 'midrand', name: 'Midrand', city: 'Johannesburg', province: 'Gauteng' },
  { slug: 'nelspruit', name: 'Nelspruit', city: 'Nelspruit', province: 'Mpumalanga' },
  { slug: 'pietermaritzburg', name: 'Pietermaritzburg', city: 'Pietermaritzburg', province: 'KwaZulu-Natal' },
  { slug: 'polokwane', name: 'Polokwane', city: 'Polokwane', province: 'Limpopo' },
  { slug: 'port-elizabeth', name: 'Port Elizabeth', city: 'Gqeberha', province: 'Eastern Cape' },
  { slug: 'pretoria', name: 'Pretoria', city: 'Pretoria', province: 'Gauteng' },
  { slug: 'randburg', name: 'Randburg', city: 'Johannesburg', province: 'Gauteng' },
  { slug: 'richards-bay', name: 'Richards Bay', city: 'Richards Bay', province: 'KwaZulu-Natal' },
  { slug: 'roodepoort', name: 'Roodepoort', city: 'Johannesburg', province: 'Gauteng' },
  { slug: 'rustenburg', name: 'Rustenburg', city: 'Rustenburg', province: 'North West' },
  { slug: 'sandton', name: 'Sandton', city: 'Johannesburg', province: 'Gauteng' },
  { slug: 'somerset-west', name: 'Somerset West', city: 'Cape Town', province: 'Western Cape' },
  { slug: 'springs', name: 'Springs', city: 'Ekurhuleni', province: 'Gauteng' },
  { slug: 'stellenbosch', name: 'Stellenbosch', city: 'Stellenbosch', province: 'Western Cape' },
  { slug: 'umhlanga', name: 'Umhlanga', city: 'Durban', province: 'KwaZulu-Natal' },
  { slug: 'vanderbijlpark', name: 'Vanderbijlpark', city: 'Vanderbijlpark', province: 'Gauteng' },
  { slug: 'vereeniging', name: 'Vereeniging', city: 'Vereeniging', province: 'Gauteng' },
  { slug: 'welkom', name: 'Welkom', city: 'Welkom', province: 'Free State' },
  { slug: 'witbank', name: 'Witbank', city: 'Witbank', province: 'Mpumalanga' },
  { slug: 'george', name: 'George', city: 'George', province: 'Western Cape' },
  { slug: 'kimberley', name: 'Kimberley', city: 'Kimberley', province: 'Northern Cape' },
  { slug: 'potchefstroom', name: 'Potchefstroom', city: 'Potchefstroom', province: 'North West' },
  { slug: 'bellville', name: 'Bellville', city: 'Cape Town', province: 'Western Cape' },
  { slug: 'pinetown', name: 'Pinetown', city: 'Durban', province: 'KwaZulu-Natal' },
  { slug: 'fourways', name: 'Fourways', city: 'Johannesburg', province: 'Gauteng' },
  { slug: 'bryanston', name: 'Bryanston', city: 'Johannesburg', province: 'Gauteng' },
  { slug: 'bedfordview', name: 'Bedfordview', city: 'Ekurhuleni', province: 'Gauteng' },
  { slug: 'ballito', name: 'Ballito', city: 'KwaDukuza', province: 'KwaZulu-Natal' },
];

// ─── Parse city page for security companies ──────────────────────────

function parseCityPage(html) {
  const companies = [];

  // Strategy 1: JSON-LD structured data
  const jsonLdRegex = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi;
  let jsonMatch;
  while ((jsonMatch = jsonLdRegex.exec(html)) !== null) {
    try {
      const data = JSON.parse(jsonMatch[1]);
      const items = Array.isArray(data) ? data : data['@graph'] ? data['@graph'] : [data];
      for (const item of items) {
        if (item['@type'] === 'LocalBusiness' || item['@type'] === 'Organization'
          || item['@type'] === 'ProfessionalService') {
          if (item.name && !companies.find(c => c.name === item.name)) {
            companies.push({
              name: item.name,
              phone: item.telephone || null,
              website: item.url || null,
              address: item.address?.streetAddress || null,
              city: item.address?.addressLocality || null,
              rating: item.aggregateRating?.ratingValue ? parseFloat(item.aggregateRating.ratingValue) : null,
              review_count: item.aggregateRating?.reviewCount ? parseInt(item.aggregateRating.reviewCount) : null,
            });
          }
        }
      }
    } catch {}
  }

  // Strategy 2: Company cards with ratings and reviews
  // Procompare typically shows company name, rating, review count, services
  const cardRegex = /<(?:div|article|section)[^>]*class="[^"]*(?:listing|company|provider|result|card|profile|business)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|article|section)>/gi;
  let cardMatch;
  while ((cardMatch = cardRegex.exec(html)) !== null) {
    const card = cardMatch[1];

    // Name
    const nameMatch = card.match(/<h[2-4][^>]*>(?:<a[^>]*>)?([^<]+)(?:<\/a>)?<\/h[2-4]>/i)
      || card.match(/<a[^>]*class="[^"]*name[^"]*"[^>]*>([^<]+)/i);
    if (!nameMatch) continue;
    const name = nameMatch[1].trim();
    if (name.length < 3 || companies.find(c => c.name.toLowerCase() === name.toLowerCase())) continue;

    // Phone
    const phoneMatch = card.match(/href="tel:([^"]+)"/i)
      || card.match(/(\b0[0-9]{2}[\s-]?[0-9]{3}[\s-]?[0-9]{4}\b)/);
    const phone = phoneMatch ? phoneMatch[1].trim() : null;

    // Rating
    const ratingMatch = card.match(/(\d+\.?\d*)\s*(?:\/\s*5|out of|stars?)/i)
      || card.match(/rating[^>]*?(\d+\.?\d*)/i);
    const rating = ratingMatch ? parseFloat(ratingMatch[1]) : null;

    // Review count
    const reviewMatch = card.match(/(\d+)\s*(?:reviews?|ratings?|verified)/i);
    const reviewCount = reviewMatch ? parseInt(reviewMatch[1]) : null;

    // Website
    const websiteMatch = card.match(/href="(https?:\/\/(?!www\.procompare)[^"]+)"/i);
    const website = websiteMatch ? websiteMatch[1] : null;

    // Profile URL on Procompare
    const profileMatch = card.match(/href="(\/[^"]*(?:company|profile|provider)[^"]*)"/i);
    const profileUrl = profileMatch ? `${BASE_URL}${profileMatch[1]}` : null;

    companies.push({ name, phone, rating, review_count: reviewCount, website, profile_url: profileUrl });
  }

  // Strategy 3: Links to company profiles
  const linkRegex = /href="(\/security-companies\/[^/"]+\/([^/"]+))"[^>]*>([^<]+)</gi;
  let linkMatch;
  while ((linkMatch = linkRegex.exec(html)) !== null) {
    const name = linkMatch[3].trim();
    if (name.length >= 3 && !companies.find(c => c.name.toLowerCase() === name.toLowerCase())) {
      companies.push({
        name,
        profile_url: `${BASE_URL}${linkMatch[1]}`,
      });
    }
  }

  return companies;
}

// ─── Store a security company ────────────────────────────────────────

async function getOrCreateCompany(company) {
  const slug = slugify(company.name);

  const { rows: existing } = await pool.query(
    'SELECT id FROM security_companies WHERE slug = $1',
    [slug]
  );
  if (existing.length > 0) {
    // Update with any new data
    await pool.query(
      `UPDATE security_companies SET
        phone = COALESCE($2, phone),
        website = COALESCE($3, website),
        google_rating = COALESCE($4, google_rating),
        google_review_count = COALESCE($5, google_review_count),
        scraped_at = NOW()
       WHERE id = $1`,
      [existing[0].id, company.phone, company.website, company.rating, company.review_count]
    );
    return existing[0].id;
  }

  const { rows } = await pool.query(
    `INSERT INTO security_companies (name, slug, phone, website, armed_response, google_rating, google_review_count, scraped_at)
     VALUES ($1, $2, $3, $4, TRUE, $5, $6, NOW())
     ON CONFLICT (slug) DO UPDATE SET scraped_at = NOW()
     RETURNING id`,
    [company.name, slug, company.phone || null, company.website || null,
     company.rating || null, company.review_count || null]
  );
  return rows[0].id;
}

// ─── Store suburb ↔ company mapping ──────────────────────────────────

async function storeMapping(cityName, cityMeta, companyId, sourceUrl) {
  await pool.query(
    `INSERT INTO suburb_security_coverage (suburb, city, province, security_company_id, source, source_url, verified_at)
     VALUES ($1, $2, $3, $4, 'procompare', $5, NOW())
     ON CONFLICT (suburb, city, security_company_id, source) DO UPDATE SET
       verified_at = NOW()`,
    [cityName, cityMeta.city, cityMeta.province, companyId, sourceUrl]
  );
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const delay = parseInt(args.find((_, i, a) => a[i - 1] === '--delay') || String(DEFAULT_DELAY_SEC));
  const maxCities = parseInt(args.find((_, i, a) => a[i - 1] === '--max') || '9999');
  const statusOnly = args.includes('--status');

  if (statusOnly) {
    const { rows: companies } = await pool.query('SELECT COUNT(*) AS c FROM security_companies');
    const { rows: mappings } = await pool.query('SELECT COUNT(*) AS c FROM suburb_security_coverage WHERE source = $1', ['procompare']);
    const { rows: cities } = await pool.query('SELECT COUNT(DISTINCT suburb) AS c FROM suburb_security_coverage WHERE source = $1', ['procompare']);
    console.log(`[procompare] ${companies[0].c} total companies, ${mappings[0].c} mappings across ${cities[0].c} cities (from procompare)`);
    process.exit(0);
  }

  // First try to discover city pages from the index
  console.log(`[procompare] Fetching index: ${INDEX_URL}`);
  let citiesToScrape = [...CITIES];

  try {
    const indexHtml = await fetchPage(INDEX_URL);

    // Look for city links we might have missed
    const cityLinkRegex = /href="\/security-companies\/([^/"]+)"[^>]*>([^<]+)</gi;
    let m;
    while ((m = cityLinkRegex.exec(indexHtml)) !== null) {
      const slug = m[1];
      const name = m[2].trim();
      if (!citiesToScrape.find(c => c.slug === slug) && name.length > 2) {
        citiesToScrape.push({ slug, name, city: name, province: null });
        console.log(`[procompare] Discovered new city: ${name}`);
      }
    }
  } catch (err) {
    console.log(`[procompare] Could not fetch index (${err.message}), using known city list`);
  }

  await sleep(delay * 1000);

  const limit = Math.min(citiesToScrape.length, maxCities);
  let totalCompanies = 0;
  let totalMappings = 0;
  let errorCount = 0;

  for (let i = 0; i < limit; i++) {
    const cityInfo = citiesToScrape[i];
    const url = `${INDEX_URL}/${cityInfo.slug}`;

    try {
      const html = await fetchPage(url);
      const companies = parseCityPage(html);

      if (companies.length === 0) {
        console.log(`[procompare] ${i + 1}/${limit}: ${cityInfo.name} — no companies found`);
      } else {
        for (const company of companies) {
          const companyId = await getOrCreateCompany(company);
          await storeMapping(cityInfo.name, cityInfo, companyId, url);
          totalMappings++;
        }

        totalCompanies += companies.length;
        console.log(`[procompare] ${i + 1}/${limit}: ${cityInfo.name} — ${companies.length} companies`);
      }
    } catch (err) {
      errorCount++;
      if (err.message.includes('HTTP 404')) {
        console.log(`[procompare] ${i + 1}/${limit}: ${cityInfo.name} — 404 not found`);
      } else {
        console.error(`[procompare] ${i + 1}/${limit}: ${cityInfo.name} — Error: ${err.message}`);
      }
    }

    if (i < limit - 1) await sleep(delay * 1000);
  }

  console.log(`\n[procompare] Done: ${limit} cities scraped, ${totalCompanies} company mentions, ${totalMappings} mappings, ${errorCount} errors`);

  const { rows: companies } = await pool.query('SELECT COUNT(*) AS c FROM security_companies');
  const { rows: mappings } = await pool.query('SELECT COUNT(*) AS c FROM suburb_security_coverage');
  console.log(`[procompare] DB totals: ${companies[0].c} companies, ${mappings[0].c} suburb-company mappings`);

  process.exit(0);
}

main().catch(err => { console.error('[procompare] Fatal:', err); process.exit(1); });
