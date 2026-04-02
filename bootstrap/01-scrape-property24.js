#!/usr/bin/env node
/**
 * PHASE 1 — Bulk scrape Property24 listings using Puppeteer
 *
 * Extracts ALL available data from each listing:
 * - From JSON-LD: type, beds, baths, floor size, lat/lng, price, agent, agency
 * - From page text: street address, listing date, levies, rates, parking,
 *   pets, furnished, floor number, description
 * - All photo URLs
 *
 * Every field is tracked with provenance linking to the exact listing URL.
 *
 * Usage:
 *   node bootstrap/01-scrape-property24.js                  # All suburbs, 1 page
 *   node bootstrap/01-scrape-property24.js --pages 3        # 3 pages per suburb
 *   node bootstrap/01-scrape-property24.js --only Gardens   # Single suburb
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const puppeteer = require('puppeteer');
const pool = require('../db');
const { recordSource } = require('../provenance');

const SUBURBS = [
  { slug: 'gardens/cape-town/western-cape', code: '9145', suburb: 'Gardens', city: 'Cape Town', province: 'Western Cape' },
  { slug: 'sea-point/cape-town/western-cape', code: '11021', suburb: 'Sea Point', city: 'Cape Town', province: 'Western Cape' },
  { slug: 'camps-bay/cape-town/western-cape', code: '8502', suburb: 'Camps Bay', city: 'Cape Town', province: 'Western Cape' },
  { slug: 'constantia/cape-town/western-cape', code: '8612', suburb: 'Constantia', city: 'Cape Town', province: 'Western Cape' },
  { slug: 'claremont/cape-town/western-cape', code: '11741', suburb: 'Claremont', city: 'Cape Town', province: 'Western Cape' },
  { slug: 'newlands/cape-town/western-cape', code: '9092', suburb: 'Newlands', city: 'Cape Town', province: 'Western Cape' },
  { slug: 'woodstock/cape-town/western-cape', code: '9410', suburb: 'Woodstock', city: 'Cape Town', province: 'Western Cape' },
  { slug: 'observatory/cape-town/western-cape', code: '9102', suburb: 'Observatory', city: 'Cape Town', province: 'Western Cape' },
  { slug: 'green-point/cape-town/western-cape', code: '8807', suburb: 'Green Point', city: 'Cape Town', province: 'Western Cape' },
  { slug: 'rondebosch/cape-town/western-cape', code: '8682', suburb: 'Rondebosch', city: 'Cape Town', province: 'Western Cape' },
  { slug: 'pinelands/cape-town/western-cape', code: '9127', suburb: 'Pinelands', city: 'Cape Town', province: 'Western Cape' },
  { slug: 'durbanville/cape-town/western-cape', code: '8720', suburb: 'Durbanville', city: 'Cape Town', province: 'Western Cape' },
  { slug: 'milnerton/cape-town/western-cape', code: '9017', suburb: 'Milnerton', city: 'Cape Town', province: 'Western Cape' },
  { slug: 'muizenberg/cape-town/western-cape', code: '9025', suburb: 'Muizenberg', city: 'Cape Town', province: 'Western Cape' },
  { slug: 'sandton/johannesburg/gauteng', code: '10681', suburb: 'Sandton', city: 'Johannesburg', province: 'Gauteng' },
  { slug: 'rosebank/johannesburg/gauteng', code: '10573', suburb: 'Rosebank', city: 'Johannesburg', province: 'Gauteng' },
  { slug: 'bryanston/johannesburg/gauteng', code: '10197', suburb: 'Bryanston', city: 'Johannesburg', province: 'Gauteng' },
  { slug: 'fourways/johannesburg/gauteng', code: '10366', suburb: 'Fourways', city: 'Johannesburg', province: 'Gauteng' },
  { slug: 'umhlanga/durban/kwazulu-natal', code: '13153', suburb: 'Umhlanga', city: 'Durban', province: 'KwaZulu-Natal' },
  { slug: 'ballito/kwazulu-natal', code: '234', suburb: 'Ballito', city: 'Durban', province: 'KwaZulu-Natal' },
  { slug: 'centurion/pretoria/gauteng', code: '10231', suburb: 'Centurion', city: 'Pretoria', province: 'Gauteng' },
  { slug: 'waterkloof/pretoria/gauteng', code: '10841', suburb: 'Waterkloof', city: 'Pretoria', province: 'Gauteng' },
];

const PAGE_DELAY_MS = 8000;
const LISTING_DELAY_MS = 4000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Extract listing IDs from search page ──────────────────────────────

async function getListingIds(page, url, areaCode) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);
  return page.evaluate((code) => {
    const found = new Set();
    document.querySelectorAll('a[href]').forEach(a => {
      const m = a.href.match(new RegExp(`/${code}/(\\d{6,})`));
      if (m) found.add(m[1]);
    });
    return [...found];
  }, areaCode);
}

// ─── Extract EVERYTHING from a single listing ──────────────────────────

async function scrapeListing(page, url) {
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
  await sleep(2000);

  return page.evaluate(() => {
    const r = { photos: [] };
    const body = document.body.innerText;

    // ── JSON-LD (most reliable structured data) ──
    document.querySelectorAll('script[type="application/ld+json"]').forEach(el => {
      try {
        const parsed = JSON.parse(el.innerHTML);
        const items = parsed['@graph'] || [parsed];
        for (const item of items) {
          if (item['@type'] === 'RealEstateListing') {
            const about = item.about || {};
            const offers = item.offers || {};
            const price = offers.priceSpecification || {};
            const agent = offers.offeredBy || {};
            const agency = agent.worksFor || {};
            const addr = about.address || {};

            r.title = item.name || null;
            r.description_headline = item.description || null;
            r.listing_url = item.url || null;
            r.listing_image = item.image || null;
            r.date_posted = item.datePosted || null;
            r.property_type_raw = about['@type'] || about.description || null;
            r.bedrooms = about.numberOfBedrooms || null;
            r.bathrooms = about.numberOfBathroomsTotal || null;
            r.floor_size = about.floorSize?.value || null;
            r.pets_allowed = about.petsAllowed || null;
            r.p24_lat = about.latitude || null;
            r.p24_lng = about.longitude || null;
            r.street_address_jsonld = addr.streetAddress || null;
            r.suburb_jsonld = addr.addressLocality || null;
            r.region_jsonld = addr.addressRegion || null;
            r.price = price.price ? parseInt(price.price) : null;
            r.currency = price.priceCurrency || null;
            r.agent_name = agent.name || null;
            r.agent_url = agent.url || null;
            r.agency_name = agency.name || null;
            r.agency_url = agency.url || null;
          }
        }
      } catch {}
    });

    // ── Page text extraction (fills gaps JSON-LD misses) ──
    const extract = (label) => {
      const re = new RegExp(label + '[:\\s]*([^\\n]+)', 'i');
      const m = body.match(re);
      return m ? m[1].trim() : null;
    };

    r.listing_number = extract('Listing Number');
    r.street_address_page = extract('Street Address');
    r.listing_date = extract('Listing Date');
    r.price_per_sqm = extract('Price per m');
    r.erf_size = extract('Erf Size');
    r.floor_number = extract('Floor Number');

    // Levies and rates — extract numbers
    const leviesText = extract('Levies');
    const ratesText = extract('Rates and Taxes');
    r.levies = leviesText ? parseInt(leviesText.replace(/[^\d]/g, '')) || null : null;
    r.rates_and_taxes = ratesText ? parseInt(ratesText.replace(/[^\d]/g, '')) || null : null;

    // Parking
    const parkMatch = body.match(/Parking:\s*(\d+)/);
    r.parking = parkMatch ? parseInt(parkMatch[1]) : null;
    const garageMatch = body.match(/Garage[s]?:\s*(\d+)/i);
    r.garages = garageMatch ? parseInt(garageMatch[1]) : null;

    // Booleans
    r.pet_friendly = body.includes('Pet Friendly') || (extract('Pets Allowed') || '').toLowerCase() === 'yes';
    r.furnished = (extract('Furnished') || '').toLowerCase() === 'yes';

    // Description — grab the main description block
    const descStart = body.indexOf('\nm²\n');
    if (descStart > -1) {
      const descEnd = body.indexOf('\nFeatures', descStart);
      if (descEnd > descStart) {
        r.description_full = body.substring(descStart + 4, descEnd).trim();
      }
    }
    if (!r.description_full) {
      // Fallback: grab text between headline and Features
      const headlineIdx = body.indexOf(r.description_headline || '___NOMATCH___');
      if (headlineIdx > -1) {
        const featIdx = body.indexOf('\nFeatures', headlineIdx);
        if (featIdx > headlineIdx) {
          r.description_full = body.substring(headlineIdx, featIdx).trim();
        }
      }
    }

    // Property type
    const typeRaw = (r.property_type_raw || extract('Type of Property') || '').toLowerCase();
    if (typeRaw.includes('apartment') || typeRaw.includes('flat')) r.property_type = 'sectional';
    else if (typeRaw.includes('house')) r.property_type = 'freehold';
    else if (typeRaw.includes('townhouse') || typeRaw.includes('cluster')) r.property_type = 'estate';
    else if (typeRaw.includes('farm')) r.property_type = 'farm';
    else r.property_type = typeRaw || null;

    // All images
    document.querySelectorAll('img[src], img[data-src], [style*="background-image"]').forEach(el => {
      let src = el.src || el.dataset?.src || '';
      if (!src && el.style?.backgroundImage) {
        const bgM = el.style.backgroundImage.match(/url\(["']?([^"')]+)/);
        if (bgM) src = bgM[1];
      }
      if (src && src.match(/\.(jpg|jpeg|png|webp)/i) && src.length > 50
          && !src.includes('logo') && !src.includes('icon') && !src.includes('avatar')
          && !src.includes('flag') && !src.includes('NoImage') && !src.includes('placeholder')) {
        const full = src.startsWith('//') ? 'https:' + src : src;
        if (full.startsWith('http') && !r.photos.includes(full)) r.photos.push(full);
      }
    });

    // Also grab the main listing image from JSON-LD
    if (r.listing_image && !r.photos.includes(r.listing_image)) {
      r.photos.unshift(r.listing_image);
    }

    return r;
  });
}

// ─── Store listing + provenance ────────────────────────────────────────

async function storeListing(listing, suburbInfo, listingId) {
  const erfNumber = `P24_${listingId}`;
  const listingUrl = `https://www.property24.com/for-sale/${suburbInfo.slug}/${suburbInfo.code}/${listingId}`;

  const { rows: existing } = await pool.query('SELECT id FROM properties WHERE erf_number = $1', [erfNumber]);
  if (existing.length > 0) return { id: existing[0].id, skipped: true };

  // Street address: only accept if it looks like a real address (not just a number)
  const rawStreet = listing.street_address_jsonld || listing.street_address_page || null;
  const streetAddr = (rawStreet && rawStreet.length > 3 && /[a-zA-Z]/.test(rawStreet)) ? rawStreet : null;

  // Title: use street address if available, otherwise listing title, never generic fallback
  const title = streetAddr
    ? `${streetAddr}, ${suburbInfo.suburb}`
    : listing.title || null;
  const erfSize = listing.erf_size ? parseInt(listing.erf_size.replace(/[^\d]/g, '')) || null : null;

  const { rows } = await pool.query(
    `INSERT INTO properties (
      erf_number, address_raw, street_address, suburb, city, province,
      property_type, floor_area_sqm, stand_size_sqm, bedrooms, bathrooms,
      listing_number, listing_url, listing_date, asking_price, price_per_sqm,
      levies, rates_and_taxes, parking_spaces, garages, floor_number,
      pet_friendly, furnished, description,
      agent_name, agent_url, agency_name, agency_url,
      listing_image_url, p24_lat, p24_lng, last_scraped_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,NOW()
    ) ON CONFLICT (erf_number) DO NOTHING RETURNING id`,
    [
      erfNumber, title, streetAddr, suburbInfo.suburb, suburbInfo.city, suburbInfo.province,
      listing.property_type, listing.floor_size, erfSize, listing.bedrooms, listing.bathrooms,
      listing.listing_number || listingId, listingUrl, listing.date_posted || listing.listing_date || null,
      listing.price, listing.price_per_sqm ? parseInt(String(listing.price_per_sqm).replace(/[^\d]/g, '')) || null : null,
      listing.levies, listing.rates_and_taxes, listing.parking, listing.garages, listing.floor_number ? parseInt(listing.floor_number) : null,
      listing.pet_friendly || null, listing.furnished || null, listing.description_full || listing.description_headline || null,
      listing.agent_name, listing.agent_url, listing.agency_name, listing.agency_url,
      listing.listing_image || null, listing.p24_lat, listing.p24_lng,
    ]
  );

  if (rows.length === 0) return { id: null, skipped: true };
  const propertyId = rows[0].id;

  // Store photos
  let photoCount = 0;
  for (const url of listing.photos.slice(0, 20)) {
    await pool.query(
      "INSERT INTO property_images (property_id, source, image_url, image_type) VALUES ($1, 'property24', $2, 'listing')",
      [propertyId, url]
    );
    photoCount++;
  }

  // Record provenance — every field linked to exact listing URL
  const trackedFields = ['address_raw', 'erf_number', 'listing_number', 'listing_url', 'listing_date', 'suburb', 'city', 'province'];
  if (streetAddr) trackedFields.push('street_address');
  if (listing.bedrooms != null) trackedFields.push('bedrooms');
  if (listing.bathrooms != null) trackedFields.push('bathrooms');
  if (listing.floor_size != null) trackedFields.push('floor_area_sqm');
  if (erfSize) trackedFields.push('stand_size_sqm');
  if (listing.property_type) trackedFields.push('property_type');
  if (listing.price) trackedFields.push('asking_price');
  if (listing.levies) trackedFields.push('levies');
  if (listing.rates_and_taxes) trackedFields.push('rates_and_taxes');
  if (listing.parking != null) trackedFields.push('parking_spaces');
  if (listing.garages != null) trackedFields.push('garages');
  if (listing.floor_number) trackedFields.push('floor_number');
  if (listing.pet_friendly != null) trackedFields.push('pet_friendly');
  if (listing.furnished != null) trackedFields.push('furnished');
  if (listing.description_full || listing.description_headline) trackedFields.push('description');
  if (listing.agent_name) trackedFields.push('agent_name');
  if (listing.agent_url) trackedFields.push('agent_url');
  if (listing.agency_name) trackedFields.push('agency_name');
  if (listing.agency_url) trackedFields.push('agency_url');
  if (listing.p24_lat) trackedFields.push('p24_lat', 'p24_lng');
  if (listing.listing_image) trackedFields.push('listing_image_url');
  if (listing.price_per_sqm) trackedFields.push('price_per_sqm');

  await recordSource(propertyId, 'Property24 Listing', listingUrl, 'scraped', trackedFields);

  return { id: propertyId, skipped: false, photos: photoCount, fields: trackedFields.length };
}

// ─── Scrape one suburb ─────────────────────────────────────────────────

async function scrapeSuburb(page, info, maxPages) {
  console.log(`\n--- ${info.suburb}, ${info.city} ---`);
  let suburbNew = 0;

  for (let pg = 1; pg <= maxPages; pg++) {
    const searchUrl = `https://www.property24.com/for-sale/${info.slug}/${info.code}${pg > 1 ? `?Page=${pg}` : ''}`;
    console.log(`  [page ${pg}] ${searchUrl}`);

    try {
      const listingIds = await getListingIds(page, searchUrl, info.code);
      console.log(`    ${listingIds.length} listings`);
      if (listingIds.length === 0) break;

      for (const lid of listingIds) {
        try {
          await sleep(LISTING_DELAY_MS);
          const listingUrl = `https://www.property24.com/for-sale/${info.slug}/${info.code}/${lid}`;
          const listing = await scrapeListing(page, listingUrl);

          const result = await storeListing(listing, info, lid);
          if (!result.skipped) {
            suburbNew++;
            const priceStr = listing.price ? `R${listing.price.toLocaleString()}` : 'no price';
            console.log(`    NEW #${result.id}: ${listing.title || 'untitled'} | ${priceStr} | ${listing.bedrooms || '?'}bed | ${result.photos}pho | ${result.fields}fields`);
          }
        } catch (err) {
          console.error(`    Error ${lid}: ${err.message}`);
        }
      }
    } catch (err) {
      console.error(`    Page error: ${err.message}`);
    }

    await sleep(PAGE_DELAY_MS);
  }

  console.log(`  ${info.suburb}: ${suburbNew} new`);
  return suburbNew;
}

// ─── CLI ───────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const pagesIdx = args.indexOf('--pages');
  const onlyIdx = args.indexOf('--only');
  const maxPages = pagesIdx >= 0 ? parseInt(args[pagesIdx + 1]) : 1;

  let suburbs = SUBURBS;
  if (onlyIdx >= 0) {
    const name = args[onlyIdx + 1];
    suburbs = SUBURBS.filter(s => s.suburb.toLowerCase().includes(name.toLowerCase()));
    if (!suburbs.length) { console.error(`No suburb matching "${name}"`); process.exit(1); }
  }

  console.log(`Scraping ${suburbs.length} suburbs, ${maxPages} page(s) each\n`);

  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  let total = 0;
  for (const info of suburbs) {
    total += await scrapeSuburb(page, info, maxPages);
  }

  await browser.close();

  const { rows: count } = await pool.query('SELECT COUNT(*) AS c FROM properties');
  const { rows: imgCount } = await pool.query('SELECT COUNT(*) AS c FROM property_images');
  console.log(`\n=== COMPLETE: ${total} new | DB: ${count[0].c} properties, ${imgCount[0].c} images ===`);

  await pool.end();
}

main().catch(err => { console.error('Fatal:', err); pool.end(); process.exit(1); });
