#!/usr/bin/env node
/**
 * ASSIST247 SECURITY COMPANY SCRAPER
 *
 * Scrapes assist247.co.za for armed response security companies mapped to suburbs.
 * This is the highest-value source: it directly maps PSIRA-approved security
 * companies to the suburbs they service.
 *
 * Strategy:
 * 1. Fetch the main areas index page to discover all suburb URLs
 * 2. For each suburb page, extract listed security companies
 * 3. Store companies and suburb↔company mappings
 *
 * Usage:
 *   node bootstrap/scrape-assist247.js                          # Scrape all suburbs
 *   node bootstrap/scrape-assist247.js --delay 3                # Seconds between requests
 *   node bootstrap/scrape-assist247.js --max 50                 # Limit suburbs to process
 *   node bootstrap/scrape-assist247.js --status                 # Show DB stats only
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const https = require('https');
const http = require('http');
const pool = require('../db');

const BASE_URL = 'https://www.assist247.co.za';
const AREAS_URL = `${BASE_URL}/matrix/areas/psira/security-services-armed-response.aspx`;
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
        'Accept-Language': 'en-US,en;q=0.5',
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

// ─── Discover suburb area pages from the main index ──────────────────

function parseAreasIndex(html) {
  const areas = [];
  // Look for links to suburb area pages
  // Pattern: /matrix/{suburb-slug}/psira/security-services-armed-response.aspx
  const regex = /href="([^"]*\/matrix\/([^/]+)\/psira\/security-services-armed-response\.aspx[^"]*)"/gi;
  let m;
  while ((m = regex.exec(html)) !== null) {
    const path = m[1];
    const slug = m[2];
    areas.push({ slug, url: path.startsWith('http') ? path : `${BASE_URL}${path.startsWith('/') ? '' : '/'}${path}` });
  }

  // Also look for simpler area links
  const regex2 = /href="([^"]*\/matrix\/([^/"]+)\/[^"]*)"[^>]*>([^<]+)</gi;
  while ((m = regex2.exec(html)) !== null) {
    const path = m[1];
    const slug = m[2];
    const name = m[3].trim();
    if (!areas.find(a => a.slug === slug) && name.length > 2 && !name.includes('PSIRA')) {
      areas.push({
        slug,
        name,
        url: path.startsWith('http') ? path : `${BASE_URL}${path.startsWith('/') ? '' : '/'}${path}`,
      });
    }
  }

  // Deduplicate by slug
  const seen = new Set();
  return areas.filter(a => {
    if (seen.has(a.slug)) return false;
    seen.add(a.slug);
    return true;
  });
}

// ─── Parse a suburb page for security companies ──────────────────────

function parseSuburbPage(html, suburbSlug) {
  const companies = [];

  // Extract suburb/area name from the page
  const titleMatch = html.match(/<h[12][^>]*>([^<]*(?:Armed Response|Security)[^<]*)<\/h[12]>/i)
    || html.match(/<h[12][^>]*>([^<]+)<\/h[12]>/i)
    || html.match(/<title>([^<]*?)(?:\s*[-|]|<)/i);
  const areaName = titleMatch
    ? titleMatch[1].replace(/(?:armed response|security services|psira|in)\s*/gi, '').replace(/\s+/g, ' ').trim()
    : suburbSlug.replace(/-/g, ' ');

  // Strategy 1: Look for company cards/listings with structured data
  // Common patterns on directory sites: company name in h3/h4, phone, rating, etc.
  const cardRegex = /<(?:div|article|li)[^>]*class="[^"]*(?:listing|company|provider|result|card)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|article|li)>/gi;
  let cardMatch;
  while ((cardMatch = cardRegex.exec(html)) !== null) {
    const card = cardMatch[1];
    const company = extractCompanyFromCard(card);
    if (company && company.name) companies.push(company);
  }

  // Strategy 2: Look for company names in links with company profile URLs
  const profileRegex = /href="([^"]*\/(?:company|profile|provider)[^"]*)"[^>]*>([^<]+)</gi;
  let profileMatch;
  while ((profileMatch = profileRegex.exec(html)) !== null) {
    const name = profileMatch[2].trim();
    const profileUrl = profileMatch[1].startsWith('http') ? profileMatch[1] : `${BASE_URL}${profileMatch[1]}`;
    if (name.length > 2 && !companies.find(c => c.name.toLowerCase() === name.toLowerCase())) {
      companies.push({ name, profile_url: profileUrl });
    }
  }

  // Strategy 3: Look for company names in any prominent text with security-related keywords
  const nameRegex = /<h[3456][^>]*>([^<]*(?:security|armed|response|guard|patrol|protect|safe)[^<]*)<\/h[3456]>/gi;
  let nameMatch;
  while ((nameMatch = nameRegex.exec(html)) !== null) {
    const name = nameMatch[1].trim();
    if (name.length > 3 && name.length < 80 && !companies.find(c => c.name.toLowerCase() === name.toLowerCase())) {
      companies.push({ name });
    }
  }

  // Strategy 4: Look for structured data (JSON-LD)
  const jsonLdRegex = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi;
  let jsonMatch;
  while ((jsonMatch = jsonLdRegex.exec(html)) !== null) {
    try {
      const data = JSON.parse(jsonMatch[1]);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item['@type'] === 'LocalBusiness' || item['@type'] === 'Organization') {
          if (item.name && !companies.find(c => c.name.toLowerCase() === item.name.toLowerCase())) {
            companies.push({
              name: item.name,
              phone: item.telephone || null,
              website: item.url || null,
              address: item.address?.streetAddress || null,
              rating: item.aggregateRating?.ratingValue || null,
              review_count: item.aggregateRating?.reviewCount || null,
            });
          }
        }
      }
    } catch {}
  }

  return { area_name: areaName, companies };
}

function extractCompanyFromCard(cardHtml) {
  // Name from heading
  const nameMatch = cardHtml.match(/<h[2-6][^>]*>([^<]+)<\/h[2-6]>/i)
    || cardHtml.match(/<a[^>]*>([^<]{3,60})<\/a>/i)
    || cardHtml.match(/<strong>([^<]{3,60})<\/strong>/i);
  if (!nameMatch) return null;
  const name = nameMatch[1].trim();

  // Phone
  const phoneMatch = cardHtml.match(/(?:tel:|phone:?\s*)\s*([0-9()+\s-]{7,})/i)
    || cardHtml.match(/href="tel:([^"]+)"/i)
    || cardHtml.match(/(\b0[0-9]{2}[\s-]?[0-9]{3}[\s-]?[0-9]{4}\b)/);
  const phone = phoneMatch ? phoneMatch[1].trim() : null;

  // Rating
  const ratingMatch = cardHtml.match(/(\d+\.?\d*)\s*(?:\/\s*5|stars?|rating)/i)
    || cardHtml.match(/rating[^>]*>(\d+\.?\d*)/i);
  const rating = ratingMatch ? parseFloat(ratingMatch[1]) : null;

  // Review count
  const reviewMatch = cardHtml.match(/(\d+)\s*(?:reviews?|ratings?)/i);
  const reviewCount = reviewMatch ? parseInt(reviewMatch[1]) : null;

  // Website
  const websiteMatch = cardHtml.match(/href="(https?:\/\/(?!www\.assist247)[^"]+)"/i);
  const website = websiteMatch ? websiteMatch[1] : null;

  // PSIRA number
  const psiraMatch = cardHtml.match(/PSIRA[^:]*[:：]\s*(\d+)/i)
    || cardHtml.match(/registration[^:]*[:：]\s*(\d+)/i);
  const psiraNumber = psiraMatch ? psiraMatch[1] : null;

  return { name, phone, rating, review_count: reviewCount, website, psira_number: psiraNumber };
}

// ─── Store a security company ────────────────────────────────────────

async function getOrCreateCompany(company) {
  const slug = slugify(company.name);

  // Check if exists
  const { rows: existing } = await pool.query(
    'SELECT id FROM security_companies WHERE slug = $1',
    [slug]
  );
  if (existing.length > 0) return existing[0].id;

  // Insert new
  const { rows } = await pool.query(
    `INSERT INTO security_companies (name, slug, psira_number, phone, website, armed_response, google_rating, google_review_count, scraped_at)
     VALUES ($1, $2, $3, $4, $5, TRUE, $6, $7, NOW())
     ON CONFLICT (slug) DO UPDATE SET
       phone = COALESCE(EXCLUDED.phone, security_companies.phone),
       website = COALESCE(EXCLUDED.website, security_companies.website),
       psira_number = COALESCE(EXCLUDED.psira_number, security_companies.psira_number),
       google_rating = COALESCE(EXCLUDED.google_rating, security_companies.google_rating),
       google_review_count = COALESCE(EXCLUDED.google_review_count, security_companies.google_review_count),
       scraped_at = NOW()
     RETURNING id`,
    [company.name, slug, company.psira_number || null, company.phone || null,
     company.website || null, company.rating || null, company.review_count || null]
  );
  return rows[0].id;
}

// ─── Store suburb ↔ company mapping ──────────────────────────────────

async function storeMapping(suburb, city, province, companyId, sourceUrl) {
  await pool.query(
    `INSERT INTO suburb_security_coverage (suburb, city, province, security_company_id, source, source_url, verified_at)
     VALUES ($1, $2, $3, $4, 'assist247', $5, NOW())
     ON CONFLICT (suburb, city, security_company_id, source) DO UPDATE SET
       verified_at = NOW()`,
    [suburb, city || null, province || null, companyId, sourceUrl]
  );
}

// ─── Infer city/province from area name ──────────────────────────────

function inferLocation(areaName) {
  const name = areaName.toLowerCase();

  // Known province/city patterns
  const cityPatterns = {
    'cape town': { city: 'Cape Town', province: 'Western Cape' },
    'johannesburg': { city: 'Johannesburg', province: 'Gauteng' },
    'pretoria': { city: 'Pretoria', province: 'Gauteng' },
    'durban': { city: 'Durban', province: 'KwaZulu-Natal' },
    'port elizabeth': { city: 'Port Elizabeth', province: 'Eastern Cape' },
    'gqeberha': { city: 'Gqeberha', province: 'Eastern Cape' },
    'bloemfontein': { city: 'Bloemfontein', province: 'Free State' },
    'east london': { city: 'East London', province: 'Eastern Cape' },
    'pietermaritzburg': { city: 'Pietermaritzburg', province: 'KwaZulu-Natal' },
    'nelspruit': { city: 'Nelspruit', province: 'Mpumalanga' },
    'polokwane': { city: 'Polokwane', province: 'Limpopo' },
    'rustenburg': { city: 'Rustenburg', province: 'North West' },
    'sandton': { city: 'Johannesburg', province: 'Gauteng' },
    'randburg': { city: 'Johannesburg', province: 'Gauteng' },
    'centurion': { city: 'Pretoria', province: 'Gauteng' },
    'midrand': { city: 'Johannesburg', province: 'Gauteng' },
    'roodepoort': { city: 'Johannesburg', province: 'Gauteng' },
    'benoni': { city: 'Ekurhuleni', province: 'Gauteng' },
    'boksburg': { city: 'Ekurhuleni', province: 'Gauteng' },
    'germiston': { city: 'Ekurhuleni', province: 'Gauteng' },
    'kempton park': { city: 'Ekurhuleni', province: 'Gauteng' },
    'alberton': { city: 'Ekurhuleni', province: 'Gauteng' },
    'umhlanga': { city: 'Durban', province: 'KwaZulu-Natal' },
    'ballito': { city: 'KwaDukuza', province: 'KwaZulu-Natal' },
    'stellenbosch': { city: 'Stellenbosch', province: 'Western Cape' },
    'paarl': { city: 'Drakenstein', province: 'Western Cape' },
    'somerset west': { city: 'Cape Town', province: 'Western Cape' },
  };

  for (const [pattern, loc] of Object.entries(cityPatterns)) {
    if (name.includes(pattern)) return loc;
  }

  return { city: null, province: null };
}

// ─── Main ────────────────────────────────────���───────────────────────

async function main() {
  const args = process.argv.slice(2);
  const delay = parseInt(args.find((_, i, a) => a[i - 1] === '--delay') || String(DEFAULT_DELAY_SEC));
  const maxAreas = parseInt(args.find((_, i, a) => a[i - 1] === '--max') || '9999');
  const statusOnly = args.includes('--status');

  if (statusOnly) {
    const { rows: companies } = await pool.query('SELECT COUNT(*) AS c FROM security_companies');
    const { rows: mappings } = await pool.query('SELECT COUNT(*) AS c FROM suburb_security_coverage WHERE source = $1', ['assist247']);
    const { rows: suburbs } = await pool.query('SELECT COUNT(DISTINCT suburb) AS c FROM suburb_security_coverage WHERE source = $1', ['assist247']);
    console.log(`[assist247] ${companies[0].c} security companies, ${mappings[0].c} suburb mappings across ${suburbs[0].c} suburbs`);
    process.exit(0);
  }

  // Step 1: Discover all area pages
  console.log(`[assist247] Fetching areas index: ${AREAS_URL}`);
  let areas;
  try {
    const indexHtml = await fetchPage(AREAS_URL);
    areas = parseAreasIndex(indexHtml);
    console.log(`[assist247] Found ${areas.length} area pages`);
  } catch (err) {
    console.error(`[assist247] Failed to fetch areas index: ${err.message}`);

    // Fallback: try common suburb URLs directly
    console.log('[assist247] Using fallback suburb list...');
    const fallbackSuburbs = [
      'sandton', 'rosebank', 'bryanston', 'fourways', 'randburg', 'midrand',
      'centurion', 'pretoria', 'hatfield', 'menlyn', 'waterkloof',
      'cape-town', 'gardens', 'sea-point', 'green-point', 'camps-bay', 'claremont',
      'constantia', 'newlands', 'rondebosch', 'hout-bay', 'table-view',
      'durban', 'umhlanga', 'ballito', 'hillcrest', 'kloof', 'la-lucia',
      'bedfordview', 'edenvale', 'germiston', 'boksburg', 'benoni',
      'alberton', 'kempton-park', 'springs', 'roodepoort', 'krugersdorp',
      'stellenbosch', 'somerset-west', 'paarl', 'franschhoek',
      'port-elizabeth', 'east-london', 'bloemfontein', 'nelspruit', 'polokwane',
      'pietermaritzburg', 'richards-bay', 'rustenburg', 'witbank',
      'vanderbijlpark', 'vereeniging', 'potchefstroom',
      'lonehill', 'dainfern', 'sunninghill', 'woodmead', 'rivonia',
      'morningside', 'parktown', 'parkview', 'melrose', 'illovo',
      'norwood', 'killarney', 'craighall', 'hyde-park', 'dunkeld',
      'linden', 'emmarentia', 'greenside', 'parkhurst', 'saxonwold',
      'observatory', 'mowbray', 'woodstock', 'salt-river',
      'bellville', 'durbanville', 'brackenfell', 'kraaifontein',
      'milnerton', 'bloubergstrand', 'parklands', 'sunningdale',
      'muizenberg', 'fish-hoek', 'simons-town', 'noordhoek', 'tokai',
    ];
    areas = fallbackSuburbs.map(s => ({
      slug: s,
      url: `${BASE_URL}/matrix/${s}/psira/security-services-armed-response.aspx`,
    }));
  }

  await sleep(delay * 1000);

  // Step 2: Scrape each area page
  const limit = Math.min(areas.length, maxAreas);
  let totalCompanies = 0;
  let totalMappings = 0;
  let errorCount = 0;

  for (let i = 0; i < limit; i++) {
    const area = areas[i];
    const url = area.url;

    try {
      const html = await fetchPage(url);
      const result = parseSuburbPage(html, area.slug);

      if (result.companies.length === 0) {
        console.log(`[assist247] ${i + 1}/${limit}: ${area.slug} — no companies found`);
      } else {
        const location = inferLocation(result.area_name || area.slug.replace(/-/g, ' '));

        for (const company of result.companies) {
          const companyId = await getOrCreateCompany(company);
          await storeMapping(result.area_name, location.city, location.province, companyId, url);
          totalMappings++;
        }

        totalCompanies += result.companies.length;
        console.log(`[assist247] ${i + 1}/${limit}: ${result.area_name} — ${result.companies.length} companies`);
      }
    } catch (err) {
      errorCount++;
      if (err.message.includes('HTTP 404')) {
        console.log(`[assist247] ${i + 1}/${limit}: ${area.slug} — 404 not found`);
      } else {
        console.error(`[assist247] ${i + 1}/${limit}: ${area.slug} — Error: ${err.message}`);
      }
    }

    if (i < limit - 1) await sleep(delay * 1000);
  }

  console.log(`\n[assist247] Done: ${limit} areas scraped, ${totalCompanies} company mentions, ${totalMappings} mappings stored, ${errorCount} errors`);

  // Final stats
  const { rows: companies } = await pool.query('SELECT COUNT(*) AS c FROM security_companies');
  const { rows: mappings } = await pool.query('SELECT COUNT(*) AS c FROM suburb_security_coverage');
  console.log(`[assist247] DB totals: ${companies[0].c} companies, ${mappings[0].c} suburb-company mappings`);

  process.exit(0);
}

main().catch(err => { console.error('[assist247] Fatal:', err); process.exit(1); });
