#!/usr/bin/env node
/**
 * PRIVATEPROPERTY.CO.ZA SCRAPER
 *
 * Much faster than P24 — no rate limiting, 16 photos per listing, plain HTTP works.
 * Paginates through province pages, scraping every listing found.
 *
 * Usage:
 *   node bootstrap/scrape-pp.js --province western-cape --code 4      # Western Cape
 *   node bootstrap/scrape-pp.js --province gauteng --code 3            # Gauteng
 *   node bootstrap/scrape-pp.js --province kwazulu-natal --code 2     # KZN
 *   node bootstrap/scrape-pp.js --max-pages 100                       # Limit pages
 *   node bootstrap/scrape-pp.js --delay 3                             # Seconds between requests
 *   node bootstrap/scrape-pp.js --status                              # Show progress
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const puppeteer = require('puppeteer');
const pool = require('../db');
const { recordSource } = require('../provenance');

const PROVINCES = {
  'western-cape':   { code: '4', name: 'Western Cape' },
  'gauteng':        { code: '3', name: 'Gauteng' },
  'kwazulu-natal':  { code: '2', name: 'KwaZulu-Natal' },
  'eastern-cape':   { code: '7', name: 'Eastern Cape' },
  'free-state':     { code: '6', name: 'Free State' },
};

const DEFAULT_DELAY_SEC = 3;
const DEFAULT_MAX_PAGES = 500;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Extract listing IDs from a search page ────────────────────────────

async function getListings(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await sleep(1500);

  return page.evaluate(() => {
    const found = [];
    document.querySelectorAll('a[href]').forEach(a => {
      const m = a.href.match(/\/for-sale\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/.+\/(T\d+)$/);
      if (m && !found.some(f => f.id === m[5])) {
        found.push({
          id: m[5],
          url: a.href,
          province: m[1],
          city_region: m[2],
          area: m[3],
          suburb: m[4],
        });
      }
    });
    return found;
  });
}

// ─── Extract ALL data from a single listing ────────────────────────────

async function extractListing(page, url) {
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 25000 });
  await sleep(1500);

  return page.evaluate(() => {
    const r = { photos: [] };
    const body = document.body.innerText;

    // Title
    r.title = document.querySelector('h1')?.textContent?.trim() || null;

    // Price
    const priceMatch = body.match(/R\s*([\d\s]+\d{3})/);
    r.price = priceMatch ? parseInt(priceMatch[1].replace(/\s/g, '')) : null;

    // Features — beds, baths, parking, sqm
    const bedMatch = body.match(/(\d+)\s*Bed/i);
    const bathMatch = body.match(/(\d+)\s*Bath/i);
    const parkMatch = body.match(/(\d+)\s*(?:Parking|Garage)/i);
    const sqmMatch = body.match(/(\d+)\s*m²/);
    const erfMatch = body.match(/Erf Size[:\s]*(\d[\d\s]*)\s*m²/i);

    r.bedrooms = bedMatch ? parseInt(bedMatch[1]) : null;
    r.bathrooms = bathMatch ? parseInt(bathMatch[1]) : null;
    r.parking = parkMatch ? parseInt(parkMatch[1]) : null;
    r.floor_area = sqmMatch ? parseInt(sqmMatch[1]) : null;
    r.erf_size = erfMatch ? parseInt(erfMatch[1].replace(/\s/g, '')) : null;

    // Levies and rates
    const levyMatch = body.match(/Lev(?:y|ies)[:\s]*R\s*([\d\s]+)/i);
    const rateMatch = body.match(/Rates[:\s]*R\s*([\d\s]+)/i);
    r.levies = levyMatch ? parseInt(levyMatch[1].replace(/\s/g, '')) : null;
    r.rates = rateMatch ? parseInt(rateMatch[1].replace(/\s/g, '')) : null;

    // Property type
    const typeText = body.toLowerCase();
    if (typeText.includes('apartment') || typeText.includes('flat')) r.property_type = 'sectional';
    else if (typeText.includes('house') && !typeText.includes('townhouse')) r.property_type = 'freehold';
    else if (typeText.includes('townhouse') || typeText.includes('cluster')) r.property_type = 'estate';
    else r.property_type = null;

    // Booleans
    r.pet_friendly = /pet[s]?\s*(?:allowed|friendly)/i.test(body);
    r.furnished = /\bfurnished\b/i.test(body);

    // Description — grab main description block
    const descEl = document.querySelector('[class*="description"], [class*="listing-body"]');
    r.description = descEl ? descEl.textContent.trim().substring(0, 3000) : null;

    // Agent
    const agentEl = document.querySelector('[class*="agent-name"], [class*="consultant"]');
    r.agent_name = agentEl ? agentEl.textContent.trim() : null;
    const agencyEl = document.querySelector('[class*="agency-name"], [class*="brand-name"]');
    r.agency_name = agencyEl ? agencyEl.textContent.trim() : null;

    // ALL photos — PP stores them in the DOM, much better than P24
    const seen = new Set();
    document.querySelectorAll('img[src], img[data-src]').forEach(el => {
      const src = el.src || el.dataset?.src || '';
      if (src.includes('images.pp.co.za') && !src.includes('logo')) {
        // Get the base image ID and request full size
        const imgMatch = src.match(/images\.pp\.co\.za\/listing\/(\d+)\/([^/]+)/);
        if (imgMatch && !seen.has(imgMatch[2])) {
          seen.add(imgMatch[2]);
          // Request largest version
          r.photos.push(`https://images.pp.co.za/listing/${imgMatch[1]}/${imgMatch[2]}/1600/1066/contain/jpegorpng`);
        }
      }
    });

    // Also scan scripts and HTML for image URLs
    const html = document.documentElement.innerHTML;
    const imgMatches = html.matchAll(/images\.pp\.co\.za\/listing\/(\d+)\/([A-Za-z0-9_-]+)/g);
    for (const m of imgMatches) {
      if (!seen.has(m[2])) {
        seen.add(m[2]);
        r.photos.push(`https://images.pp.co.za/listing/${m[1]}/${m[2]}/1600/1066/contain/jpegorpng`);
      }
    }

    return r;
  });
}

// ─── Store listing ─────────────────────────────────────────────────────

async function storeListing(listing, meta, listingUrl) {
  const erfNumber = `PP_${meta.id}`;

  // Skip if already stored
  const { rows: existing } = await pool.query('SELECT id FROM properties WHERE erf_number = $1', [erfNumber]);
  if (existing.length > 0) return { id: existing[0].id, skipped: true };

  // Derive suburb/city from URL path
  const suburb = meta.suburb.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const cityRegion = meta.city_region.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const province = meta.province.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  const title = listing.title || `${suburb}, ${cityRegion}`;

  const { rows } = await pool.query(
    `INSERT INTO properties (
      erf_number, address_raw, suburb, city, province,
      property_type, floor_area_sqm, stand_size_sqm, bedrooms, bathrooms,
      listing_number, listing_url, asking_price,
      levies, rates_and_taxes, parking_spaces,
      pet_friendly, furnished, description,
      agent_name, agency_name,
      listing_image_url, last_scraped_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,NOW())
    ON CONFLICT (erf_number) DO NOTHING RETURNING id`,
    [
      erfNumber, title, suburb, cityRegion, province,
      listing.property_type, listing.floor_area, listing.erf_size, listing.bedrooms, listing.bathrooms,
      meta.id, listingUrl, listing.price,
      listing.levies, listing.rates, listing.parking,
      listing.pet_friendly || null, listing.furnished || null, listing.description,
      listing.agent_name, listing.agency_name,
      listing.photos[0] || null,
    ]
  );

  if (rows.length === 0) return { id: null, skipped: true };
  const propertyId = rows[0].id;

  // Store ALL photos
  let photoCount = 0;
  const photosSeen = new Set();
  for (const url of listing.photos) {
    const imgId = url.match(/\/([A-Za-z0-9_-]+)\/\d+\/\d+\//)?.[1];
    if (imgId && photosSeen.has(imgId)) continue;
    if (imgId) photosSeen.add(imgId);
    await pool.query(
      "INSERT INTO property_images (property_id, source, image_url, image_type) VALUES ($1, 'privateproperty', $2, 'listing')",
      [propertyId, url]
    );
    photoCount++;
  }

  // Provenance — link to exact listing page
  const fields = ['address_raw', 'erf_number', 'listing_number', 'listing_url', 'suburb', 'city', 'province'];
  if (listing.bedrooms != null) fields.push('bedrooms');
  if (listing.bathrooms != null) fields.push('bathrooms');
  if (listing.floor_area) fields.push('floor_area_sqm');
  if (listing.erf_size) fields.push('stand_size_sqm');
  if (listing.property_type) fields.push('property_type');
  if (listing.price) fields.push('asking_price');
  if (listing.levies) fields.push('levies');
  if (listing.rates) fields.push('rates_and_taxes');
  if (listing.parking) fields.push('parking_spaces');
  if (listing.pet_friendly) fields.push('pet_friendly');
  if (listing.description) fields.push('description');
  if (listing.agent_name) fields.push('agent_name');
  if (listing.agency_name) fields.push('agency_name');

  await recordSource(propertyId, 'PrivateProperty Listing', listingUrl, 'scraped', fields);

  // Training data
  await pool.query(
    `INSERT INTO training_data (property_id, price_zar, price_per_sqm, floor_area_sqm, stand_size_sqm,
      bedrooms, bathrooms, parking_total, levies_monthly, rates_monthly,
      suburb, city, property_type, pet_friendly, furnished, data_completeness)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (property_id) DO NOTHING`,
    [
      propertyId, listing.price,
      listing.price && listing.floor_area ? Math.round(listing.price / listing.floor_area) : null,
      listing.floor_area, listing.erf_size,
      listing.bedrooms, listing.bathrooms, listing.parking,
      listing.levies, listing.rates,
      suburb, cityRegion, listing.property_type,
      listing.pet_friendly || false, listing.furnished || false,
      fields.length / 20,
    ]
  );

  return { id: propertyId, skipped: false, photos: photoCount, fields: fields.length };
}

// ─── Main ──────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--status')) {
    const { rows: pp } = await pool.query("SELECT COUNT(*) AS c FROM properties WHERE erf_number LIKE 'PP_%'");
    const { rows: imgs } = await pool.query("SELECT COUNT(*) AS c FROM property_images WHERE source = 'privateproperty'");
    console.log(`PrivateProperty: ${pp[0].c} properties, ${imgs[0].c} images`);
    await pool.end();
    return;
  }

  const provinceKey = args.includes('--province') ? args[args.indexOf('--province') + 1] : 'western-cape';
  const provinceCode = args.includes('--code') ? args[args.indexOf('--code') + 1] : PROVINCES[provinceKey]?.code || '4';
  const maxPages = args.includes('--max-pages') ? parseInt(args[args.indexOf('--max-pages') + 1]) : DEFAULT_MAX_PAGES;
  const delaySec = args.includes('--delay') ? parseInt(args[args.indexOf('--delay') + 1]) : DEFAULT_DELAY_SEC;
  const startPage = args.includes('--start-page') ? parseInt(args[args.indexOf('--start-page') + 1]) : 1;

  const provinceName = PROVINCES[provinceKey]?.name || provinceKey;
  console.log(`\nScraping PrivateProperty — ${provinceName} (code ${provinceCode})`);
  console.log(`Pages ${startPage} to ${maxPages}, ${delaySec}s delay\n`);

  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  let totalStored = 0;
  let totalSkipped = 0;
  let totalPhotos = 0;
  let emptyPages = 0;

  for (let pg = startPage; pg <= maxPages; pg++) {
    const searchUrl = `https://www.privateproperty.co.za/for-sale/${provinceKey}/${provinceCode}?page=${pg}`;
    console.log(`[page ${pg}] ${searchUrl}`);

    try {
      const listings = await getListings(page, searchUrl);
      console.log(`  ${listings.length} listings`);

      if (listings.length === 0) {
        emptyPages++;
        if (emptyPages >= 3) { console.log('  3 empty pages in a row — done'); break; }
        continue;
      }
      emptyPages = 0;

      for (const meta of listings) {
        // Skip if already in DB
        const { rows: exists } = await pool.query("SELECT id FROM properties WHERE erf_number = $1", [`PP_${meta.id}`]);
        if (exists.length > 0) { totalSkipped++; continue; }

        try {
          await sleep(delaySec * 1000);
          const listing = await extractListing(page, meta.url);

          if (!listing.title && !listing.price) {
            console.log(`    SKIP ${meta.id} — empty page`);
            continue;
          }

          const result = await storeListing(listing, meta, meta.url);
          if (result.skipped) {
            totalSkipped++;
          } else {
            totalStored++;
            totalPhotos += result.photos || 0;
            const priceStr = listing.price ? `R${listing.price.toLocaleString()}` : '-';
            console.log(`    NEW #${result.id} ${listing.title || 'untitled'} | ${priceStr} | ${listing.bedrooms || '?'}bed | ${result.photos}pho`);
          }
        } catch (err) {
          console.error(`    ERROR ${meta.id}: ${err.message}`);
        }
      }
    } catch (err) {
      console.error(`  Page error: ${err.message}`);
    }

    // Progress every 10 pages
    if (pg % 10 === 0) {
      console.log(`\n  --- Page ${pg}: ${totalStored} stored, ${totalSkipped} skipped, ${totalPhotos} photos ---\n`);
    }

    await sleep(delaySec * 1000);
  }

  await browser.close();

  console.log(`\n=== PP SCRAPE COMPLETE ===`);
  console.log(`  Province: ${provinceName}`);
  console.log(`  New properties: ${totalStored}`);
  console.log(`  Photos stored: ${totalPhotos}`);
  console.log(`  Skipped (already in DB): ${totalSkipped}`);

  const { rows: total } = await pool.query("SELECT COUNT(*) AS c FROM properties");
  const { rows: ppTotal } = await pool.query("SELECT COUNT(*) AS c FROM properties WHERE erf_number LIKE 'PP_%'");
  console.log(`  DB total: ${total[0].c} properties (${ppTotal[0].c} from PP)`);

  await pool.end();
}

main().catch(err => { console.error('Fatal:', err); pool.end(); process.exit(1); });
