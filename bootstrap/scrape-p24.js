#!/usr/bin/env node
/**
 * COMPREHENSIVE PROPERTY24 SCRAPER
 *
 * Queue-based, resumable, rate-limit-aware.
 * Tracks every scrape attempt. Can be stopped and restarted.
 *
 * How it works:
 * 1. Creates scrape_jobs for each suburb (if not already created)
 * 2. For each pending/in-progress job:
 *    - Opens the suburb search page in Puppeteer
 *    - Extracts listing IDs from each page
 *    - Visits each listing and extracts ALL data
 *    - Stores in properties + property_images + scrape_log
 *    - Updates training_data with normalized features
 *    - Tracks progress so it can resume if stopped
 * 3. If P24 blocks (503/403), waits and retries
 *
 * Usage:
 *   node bootstrap/scrape-p24.js                    # Resume all pending jobs
 *   node bootstrap/scrape-p24.js --setup            # Create jobs for all suburbs
 *   node bootstrap/scrape-p24.js --status           # Show progress
 *   node bootstrap/scrape-p24.js --suburb Gardens   # Run one suburb only
 *   node bootstrap/scrape-p24.js --max-pages 20     # Scrape deeper
 *   node bootstrap/scrape-p24.js --delay 15         # Seconds between requests
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const puppeteer = require('puppeteer');
const pool = require('../db');
const { recordSource } = require('../provenance');

// ─── All SA suburbs we want to scrape ──────────────────────────────────

const ALL_SUBURBS = [
  // Cape Town
  { slug: 'gardens/cape-town/western-cape', code: '9145', suburb: 'Gardens', city: 'Cape Town', province: 'Western Cape' },
  { slug: 'sea-point/cape-town/western-cape', code: '11021', suburb: 'Sea Point', city: 'Cape Town', province: 'Western Cape' },
  { slug: 'camps-bay/cape-town/western-cape', code: '8502', suburb: 'Camps Bay', city: 'Cape Town', province: 'Western Cape' },
  { slug: 'constantia/cape-town/western-cape', code: '8612', suburb: 'Constantia', city: 'Cape Town', province: 'Western Cape' },
  { slug: 'claremont/cape-town/western-cape', code: '11741', suburb: 'Claremont', city: 'Cape Town', province: 'Western Cape' },
  { slug: 'newlands/cape-town/western-cape', code: '9092', suburb: 'Newlands', city: 'Cape Town', province: 'Western Cape' },
  { slug: 'woodstock/cape-town/western-cape', code: '9410', suburb: 'Woodstock', city: 'Cape Town', province: 'Western Cape' },
  { slug: 'observatory/cape-town/western-cape', code: '9102', suburb: 'Observatory', city: 'Cape Town', province: 'Western Cape' },
  { slug: 'green-point/cape-town/western-cape', code: '8807', suburb: 'Green Point', city: 'Cape Town', province: 'Western Cape' },
  { slug: 'tamboerskloof/cape-town/western-cape', code: '9291', suburb: 'Tamboerskloof', city: 'Cape Town', province: 'Western Cape' },
  { slug: 'rondebosch/cape-town/western-cape', code: '8682', suburb: 'Rondebosch', city: 'Cape Town', province: 'Western Cape' },
  { slug: 'pinelands/cape-town/western-cape', code: '9127', suburb: 'Pinelands', city: 'Cape Town', province: 'Western Cape' },
  { slug: 'bellville/cape-town/western-cape', code: '8393', suburb: 'Bellville', city: 'Cape Town', province: 'Western Cape' },
  { slug: 'durbanville/cape-town/western-cape', code: '8720', suburb: 'Durbanville', city: 'Cape Town', province: 'Western Cape' },
  { slug: 'milnerton/cape-town/western-cape', code: '9017', suburb: 'Milnerton', city: 'Cape Town', province: 'Western Cape' },
  { slug: 'table-view/cape-town/western-cape', code: '9283', suburb: 'Table View', city: 'Cape Town', province: 'Western Cape' },
  { slug: 'muizenberg/cape-town/western-cape', code: '9025', suburb: 'Muizenberg', city: 'Cape Town', province: 'Western Cape' },
  { slug: 'kalk-bay/cape-town/western-cape', code: '8942', suburb: 'Kalk Bay', city: 'Cape Town', province: 'Western Cape' },
  { slug: 'hout-bay/cape-town/western-cape', code: '8897', suburb: 'Hout Bay', city: 'Cape Town', province: 'Western Cape' },
  { slug: 'somerset-west/western-cape', code: '390', suburb: 'Somerset West', city: 'Cape Town', province: 'Western Cape' },
  { slug: 'stellenbosch/western-cape', code: '393', suburb: 'Stellenbosch', city: 'Stellenbosch', province: 'Western Cape' },
  { slug: 'strand/western-cape', code: '392', suburb: 'Strand', city: 'Cape Town', province: 'Western Cape' },
  // Johannesburg
  { slug: 'sandton/johannesburg/gauteng', code: '10681', suburb: 'Sandton', city: 'Johannesburg', province: 'Gauteng' },
  { slug: 'rosebank/johannesburg/gauteng', code: '10573', suburb: 'Rosebank', city: 'Johannesburg', province: 'Gauteng' },
  { slug: 'bryanston/johannesburg/gauteng', code: '10197', suburb: 'Bryanston', city: 'Johannesburg', province: 'Gauteng' },
  { slug: 'fourways/johannesburg/gauteng', code: '10366', suburb: 'Fourways', city: 'Johannesburg', province: 'Gauteng' },
  { slug: 'randburg/johannesburg/gauteng', code: '10543', suburb: 'Randburg', city: 'Johannesburg', province: 'Gauteng' },
  { slug: 'bedfordview/johannesburg/gauteng', code: '10140', suburb: 'Bedfordview', city: 'Johannesburg', province: 'Gauteng' },
  { slug: 'northcliff/johannesburg/gauteng', code: '10475', suburb: 'Northcliff', city: 'Johannesburg', province: 'Gauteng' },
  { slug: 'parkhurst/johannesburg/gauteng', code: '10506', suburb: 'Parkhurst', city: 'Johannesburg', province: 'Gauteng' },
  { slug: 'linden/johannesburg/gauteng', code: '10427', suburb: 'Linden', city: 'Johannesburg', province: 'Gauteng' },
  // Pretoria
  { slug: 'centurion/pretoria/gauteng', code: '10231', suburb: 'Centurion', city: 'Pretoria', province: 'Gauteng' },
  { slug: 'waterkloof/pretoria/gauteng', code: '10841', suburb: 'Waterkloof', city: 'Pretoria', province: 'Gauteng' },
  { slug: 'brooklyn/pretoria/gauteng', code: '10194', suburb: 'Brooklyn', city: 'Pretoria', province: 'Gauteng' },
  { slug: 'menlo-park/pretoria/gauteng', code: '10445', suburb: 'Menlo Park', city: 'Pretoria', province: 'Gauteng' },
  { slug: 'hatfield/pretoria/gauteng', code: '10381', suburb: 'Hatfield', city: 'Pretoria', province: 'Gauteng' },
  // Durban
  { slug: 'umhlanga/durban/kwazulu-natal', code: '13153', suburb: 'Umhlanga', city: 'Durban', province: 'KwaZulu-Natal' },
  { slug: 'ballito/kwazulu-natal', code: '234', suburb: 'Ballito', city: 'Durban', province: 'KwaZulu-Natal' },
  { slug: 'morningside/durban/kwazulu-natal', code: '13031', suburb: 'Morningside', city: 'Durban', province: 'KwaZulu-Natal' },
  { slug: 'berea/durban/kwazulu-natal', code: '12779', suburb: 'Berea', city: 'Durban', province: 'KwaZulu-Natal' },
  { slug: 'westville/durban/kwazulu-natal', code: '13167', suburb: 'Westville', city: 'Durban', province: 'KwaZulu-Natal' },
  // Other
  { slug: 'port-elizabeth/eastern-cape', code: '148', suburb: 'Port Elizabeth', city: 'Port Elizabeth', province: 'Eastern Cape' },
  { slug: 'bloemfontein/free-state', code: '97', suburb: 'Bloemfontein', city: 'Bloemfontein', province: 'Free State' },
];

const DEFAULT_DELAY_SEC = 12;
const BLOCK_WAIT_SEC = 120;
const DEFAULT_MAX_PAGES = 50; // P24 typically has 20-30 pages per suburb

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Setup: create jobs for all suburbs ────────────────────────────────

async function setupJobs() {
  let created = 0;
  for (const s of ALL_SUBURBS) {
    const { rows } = await pool.query(
      'SELECT id FROM scrape_jobs WHERE suburb_slug = $1',
      [s.slug]
    );
    if (rows.length === 0) {
      await pool.query(
        `INSERT INTO scrape_jobs (suburb_slug, suburb_name, city, province, area_code)
         VALUES ($1, $2, $3, $4, $5)`,
        [s.slug, s.suburb, s.city, s.province, s.code]
      );
      created++;
    }
  }
  console.log(`Created ${created} new jobs (${ALL_SUBURBS.length} total suburbs)`);
}

// ─── Status ────────────────────────────────────────────────────────────

async function showStatus() {
  const { rows: jobs } = await pool.query(
    `SELECT status, COUNT(*) AS cnt, SUM(total_listings_stored) AS stored, SUM(total_pages_scraped) AS pages
     FROM scrape_jobs GROUP BY status ORDER BY status`
  );
  console.log('\n=== SCRAPE STATUS ===');
  for (const j of jobs) {
    console.log(`  ${j.status}: ${j.cnt} suburbs, ${j.stored || 0} listings, ${j.pages || 0} pages`);
  }

  const { rows: totals } = await pool.query('SELECT COUNT(*) AS props FROM properties');
  const { rows: imgs } = await pool.query('SELECT COUNT(*) AS imgs FROM property_images');
  const { rows: training } = await pool.query('SELECT COUNT(*) AS t FROM training_data');
  console.log(`\n  Database: ${totals[0].props} properties, ${imgs[0].imgs} images, ${training[0].t} training records`);

  // Show pending jobs
  const { rows: pending } = await pool.query(
    `SELECT suburb_name, city, last_page_scraped, total_listings_stored
     FROM scrape_jobs WHERE status IN ('pending', 'in_progress') ORDER BY suburb_name LIMIT 20`
  );
  if (pending.length > 0) {
    console.log('\n  Pending/in-progress:');
    for (const p of pending) {
      console.log(`    ${p.suburb_name}, ${p.city} — page ${p.last_page_scraped}, ${p.total_listings_stored} stored`);
    }
  }
}

// ─── Extract listing data from page ────────────────────────────────────

async function extractListing(page) {
  // Try to open photo gallery to get ALL images
  try {
    // Click "See all X images" or the photo count button
    await page.evaluate(() => {
      const btns = document.querySelectorAll('a, button, div');
      for (const b of btns) {
        const text = b.textContent || '';
        if (text.match(/see all \d+ image/i) || text.match(/photos? \(\d+\)/i) || text.match(/\d+ photos/i)) {
          b.click();
          return;
        }
      }
      const mainImg = document.querySelector('[class*="gallery"] img, [class*="slider"] img, [class*="carousel"] img');
      if (mainImg) mainImg.click();
    });
    await new Promise(r => setTimeout(r, 1500));
  } catch {}

  return page.evaluate(() => {
    const r = { photos: [] };
    const body = document.body.innerText;

    // JSON-LD
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
            r.headline = item.description || null;
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
            r.street_address = addr.streetAddress || null;
            r.suburb = addr.addressLocality || null;
            r.region = addr.addressRegion || null;
            r.price = price.price ? parseInt(price.price) : null;
            r.agent_name = agent.name || null;
            r.agent_url = agent.url || null;
            r.agency_name = agency.name || null;
            r.agency_url = agency.url || null;
          }
        }
      } catch {}
    });

    // Page text extraction
    const extract = (label) => {
      const m = body.match(new RegExp(label + '[:\\s]*([^\\n]+)', 'i'));
      return m ? m[1].trim() : null;
    };

    r.listing_number = extract('Listing Number');
    r.listing_date_text = extract('Listing Date');
    r.erf_size_text = extract('Erf Size');
    r.floor_number_text = extract('Floor Number');

    const levies = extract('Levies');
    r.levies = levies ? parseInt(levies.replace(/[^\d]/g, '')) || null : null;
    const rates = extract('Rates and Taxes');
    r.rates_and_taxes = rates ? parseInt(rates.replace(/[^\d]/g, '')) || null : null;

    const parkMatch = body.match(/Parking:\s*(\d+)/);
    r.parking = parkMatch ? parseInt(parkMatch[1]) : null;
    const garageMatch = body.match(/Garage[s]?:\s*(\d+)/i);
    r.garages = garageMatch ? parseInt(garageMatch[1]) : null;

    r.pet_friendly = body.includes('Pet Friendly') || (extract('Pets Allowed') || '').toLowerCase() === 'yes';
    r.furnished = (extract('Furnished') || '').toLowerCase() === 'yes';

    // Property type
    const typeRaw = (r.property_type_raw || extract('Type of Property') || '').toLowerCase();
    if (typeRaw.includes('apartment') || typeRaw.includes('flat')) r.property_type = 'sectional';
    else if (typeRaw.includes('house') && !typeRaw.includes('townhouse')) r.property_type = 'freehold';
    else if (typeRaw.includes('townhouse') || typeRaw.includes('cluster')) r.property_type = 'estate';
    else r.property_type = typeRaw || null;

    // Description
    const descStart = body.indexOf('\nm²\n');
    if (descStart > -1) {
      const descEnd = body.indexOf('\nFeatures', descStart);
      if (descEnd > descStart) r.description = body.substring(descStart + 4, descEnd).trim();
    }

    // Photos — collect ALL P24 CDN images from every possible source
    const seen = new Set();
    function addPhoto(src) {
      if (!src || !src.includes('images.prop24.com') || src.includes('NoImage')) return;
      const imgId = src.match(/prop24\.com\/(\d+)/)?.[1];
      if (!imgId || seen.has(imgId)) return;
      seen.add(imgId);
      // Always request highest resolution
      const hiRes = `https://images.prop24.com/${imgId}/Ensure960x540`;
      r.photos.push(hiRes);
    }

    // 1. All img tags (including lazy-loaded)
    document.querySelectorAll('img').forEach(el => {
      addPhoto(el.src);
      addPhoto(el.dataset?.src);
      addPhoto(el.dataset?.lazySrc);
      addPhoto(el.dataset?.original);
      // srcset can contain multiple URLs
      (el.srcset || '').split(',').forEach(s => addPhoto(s.trim().split(' ')[0]));
    });

    // 2. Background images
    document.querySelectorAll('[style*="background"]').forEach(el => {
      const m = el.style?.backgroundImage?.match(/url\(["']?([^"')]+)/);
      if (m) addPhoto(m[1]);
    });

    // 3. ALL script tags — P24 embeds image arrays in JavaScript
    const pageHTML = document.documentElement.innerHTML;
    const scriptMatches = pageHTML.matchAll(/images\.prop24\.com\/(\d+)\/([A-Za-z0-9]+)/g);
    for (const m of scriptMatches) addPhoto(`https://images.prop24.com/${m[1]}/${m[2]}`);

    // 4. data-* attributes that might contain image URLs
    document.querySelectorAll('[data-image-url], [data-photo], [data-src]').forEach(el => {
      for (const attr of el.attributes) {
        if (attr.value.includes('images.prop24.com')) addPhoto(attr.value);
      }
    });

    // 5. JSON-LD listing image
    if (r.listing_image) addPhoto(r.listing_image);

    // Count for logging
    r.photo_count_from_page = r.photos.length;

    return r;
  });
}

// ─── Store listing ─────────────────────────────────────────────────────

async function storeListing(listing, suburbInfo, listingId, jobId, listingUrl) {
  const erfNumber = `P24_${listingId}`;

  // Check if already scraped
  const { rows: existing } = await pool.query('SELECT id FROM properties WHERE erf_number = $1', [erfNumber]);
  if (existing.length > 0) {
    await pool.query(
      `INSERT INTO scrape_log (job_id, listing_id, listing_url, property_id, status, fields_extracted, photos_found)
       VALUES ($1, $2, $3, $4, 'skipped', 0, 0)`,
      [jobId, listingId, listingUrl, existing[0].id]
    );
    return { id: existing[0].id, skipped: true };
  }

  const streetAddr = (listing.street_address && listing.street_address.length > 3) ? listing.street_address : null;
  const title = streetAddr ? `${streetAddr}, ${suburbInfo.suburb}` : listing.title || null;
  const erfSize = listing.erf_size_text ? parseInt(listing.erf_size_text.replace(/[^\d]/g, '')) || null : null;

  const { rows } = await pool.query(
    `INSERT INTO properties (
      erf_number, address_raw, street_address, suburb, city, province,
      property_type, floor_area_sqm, stand_size_sqm, bedrooms, bathrooms,
      listing_number, listing_url, listing_date, asking_price,
      levies, rates_and_taxes, parking_spaces, garages, floor_number,
      pet_friendly, furnished, description,
      agent_name, agent_url, agency_name, agency_url,
      listing_image_url, p24_lat, p24_lng, last_scraped_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,NOW())
    ON CONFLICT (erf_number) DO NOTHING RETURNING id`,
    [
      erfNumber, title, streetAddr, suburbInfo.suburb, suburbInfo.city, suburbInfo.province,
      listing.property_type, listing.floor_size, erfSize, listing.bedrooms, listing.bathrooms,
      listing.listing_number || listingId, listingUrl, listing.date_posted || listing.listing_date_text || null,
      listing.price, listing.levies, listing.rates_and_taxes, listing.parking, listing.garages,
      listing.floor_number_text ? parseInt(listing.floor_number_text) : null,
      listing.pet_friendly || null, listing.furnished || null, listing.description || listing.headline,
      listing.agent_name, listing.agent_url, listing.agency_name, listing.agency_url,
      listing.listing_image, listing.p24_lat, listing.p24_lng,
    ]
  );

  if (rows.length === 0) return { id: null, skipped: true };
  const propertyId = rows[0].id;

  // Photos
  const photosStored = new Set();
  for (const url of listing.photos.slice(0, 30)) {
    const imgId = url.match(/prop24\.com\/(\d+)/)?.[1];
    if (imgId && photosStored.has(imgId)) continue;
    if (imgId) photosStored.add(imgId);
    await pool.query(
      "INSERT INTO property_images (property_id, source, image_url, image_type) VALUES ($1, 'property24', $2, 'listing')",
      [propertyId, url]
    );
  }

  // Provenance
  const fields = ['address_raw', 'erf_number', 'listing_number', 'listing_url', 'suburb', 'city', 'province'];
  if (streetAddr) fields.push('street_address');
  if (listing.bedrooms != null) fields.push('bedrooms');
  if (listing.bathrooms != null) fields.push('bathrooms');
  if (listing.floor_size) fields.push('floor_area_sqm');
  if (erfSize) fields.push('stand_size_sqm');
  if (listing.property_type) fields.push('property_type');
  if (listing.price) fields.push('asking_price');
  if (listing.levies) fields.push('levies');
  if (listing.rates_and_taxes) fields.push('rates_and_taxes');
  if (listing.parking != null) fields.push('parking_spaces');
  if (listing.garages != null) fields.push('garages');
  if (listing.pet_friendly) fields.push('pet_friendly');
  if (listing.furnished) fields.push('furnished');
  if (listing.description || listing.headline) fields.push('description');
  if (listing.agent_name) fields.push('agent_name', 'agent_url');
  if (listing.agency_name) fields.push('agency_name', 'agency_url');
  if (listing.p24_lat) fields.push('p24_lat', 'p24_lng');
  if (listing.listing_image) fields.push('listing_image_url');
  if (listing.date_posted) fields.push('listing_date');

  await recordSource(propertyId, 'Property24 Listing', listingUrl, 'scraped', fields);

  // Training data
  const daysOnMarket = listing.date_posted ? Math.floor((Date.now() - new Date(listing.date_posted).getTime()) / 86400000) : null;
  await pool.query(
    `INSERT INTO training_data (property_id, price_zar, price_per_sqm, floor_area_sqm, stand_size_sqm,
      bedrooms, bathrooms, parking_total, floor_number, levies_monthly, rates_monthly, days_on_market,
      suburb, city, property_type, pet_friendly, furnished, data_completeness)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     ON CONFLICT DO NOTHING`,
    [
      propertyId, listing.price,
      listing.price && listing.floor_size ? Math.round(listing.price / listing.floor_size) : null,
      listing.floor_size, erfSize,
      listing.bedrooms, listing.bathrooms,
      (listing.parking || 0) + (listing.garages || 0),
      listing.floor_number_text ? parseInt(listing.floor_number_text) : null,
      listing.levies, listing.rates_and_taxes, daysOnMarket,
      suburbInfo.suburb, suburbInfo.city, listing.property_type,
      listing.pet_friendly || false, listing.furnished || false,
      fields.length / 25, // data completeness as fraction of max fields
    ]
  );

  // Log
  await pool.query(
    `INSERT INTO scrape_log (job_id, listing_id, listing_url, property_id, status, fields_extracted, photos_found)
     VALUES ($1, $2, $3, $4, 'success', $5, $6)`,
    [jobId, listingId, listingUrl, propertyId, fields.length, photosStored.size]
  );

  return { id: propertyId, skipped: false, fields: fields.length, photos: photosStored.size };
}

// ─── Run one job ───────────────────────────────────────────────────────

async function runJob(job, browser, maxPages, delaySec) {
  console.log(`\n=== ${job.suburb_name}, ${job.city} (job #${job.id}) ===`);
  console.log(`  Resuming from page ${job.last_page_scraped + 1}`);

  await pool.query("UPDATE scrape_jobs SET status='in_progress', started_at=COALESCE(started_at, NOW()) WHERE id=$1", [job.id]);

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  let totalStored = job.total_listings_stored || 0;
  let totalSkipped = job.total_listings_skipped || 0;
  let totalFound = job.total_listings_found || 0;
  let blocked = false;

  for (let pg = job.last_page_scraped + 1; pg <= maxPages; pg++) {
    const searchUrl = `https://www.property24.com/for-sale/${job.suburb_slug}/${job.area_code}${pg > 1 ? `?Page=${pg}` : ''}`;
    console.log(`  [page ${pg}] ${searchUrl}`);

    try {
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(2000);

      // Check for block
      const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 200));
      if (bodyText.includes('Server unavailable') || bodyText.includes('Access Denied')) {
        console.log(`  BLOCKED — waiting ${BLOCK_WAIT_SEC}s...`);
        await sleep(BLOCK_WAIT_SEC * 1000);
        // Retry once
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(2000);
        const retry = await page.evaluate(() => document.body.innerText.substring(0, 200));
        if (retry.includes('Server unavailable') || retry.includes('Access Denied')) {
          console.log('  Still blocked — pausing job');
          blocked = true;
          break;
        }
      }

      // Extract listing IDs
      const listingIds = await page.evaluate((code) => {
        const found = new Set();
        document.querySelectorAll('a[href]').forEach(a => {
          const m = a.href.match(new RegExp(`/${code}/(\\d{6,})`));
          if (m) found.add(m[1]);
        });
        return [...found];
      }, job.area_code);

      console.log(`    ${listingIds.length} listings`);
      if (listingIds.length === 0) {
        console.log('    No more listings — suburb complete');
        break;
      }

      totalFound += listingIds.length;

      // Process each listing — skip ones already stored successfully
      for (const lid of listingIds) {
        // Skip if we already have this property in our database
        const { rows: alreadyStored } = await pool.query(
          "SELECT id FROM properties WHERE erf_number = $1", [`P24_${lid}`]
        );
        if (alreadyStored.length > 0) { totalSkipped++; continue; }

        try {
          await sleep(delaySec * 1000);
          const listingUrl = `https://www.property24.com/for-sale/${job.suburb_slug}/${job.area_code}/${lid}`;
          await page.goto(listingUrl, { waitUntil: 'networkidle0', timeout: 30000 });
          await sleep(2000);

          const listing = await extractListing(page);
          if (!listing.title && !listing.price) {
            // Page didn't load properly
            await pool.query(
              "INSERT INTO scrape_log (job_id, listing_id, listing_url, status, error_message) VALUES ($1,$2,$3,'failed','Empty page')",
              [job.id, lid, listingUrl]
            );
            continue;
          }

          const result = await storeListing(listing, {
            suburb: job.suburb_name, city: job.city, province: job.province, slug: job.suburb_slug
          }, lid, job.id, listingUrl);

          if (result.skipped) {
            totalSkipped++;
          } else {
            totalStored++;
            const priceStr = listing.price ? `R${listing.price.toLocaleString()}` : '-';
            console.log(`    #${result.id} ${listing.title || 'untitled'} | ${priceStr} | ${result.fields}f ${result.photos}p`);
          }
        } catch (err) {
          console.error(`    Error ${lid}: ${err.message}`);
          await pool.query(
            "INSERT INTO scrape_log (job_id, listing_id, listing_url, status, error_message) VALUES ($1,$2,$3,'failed',$4)",
            [job.id, lid, `https://www.property24.com/for-sale/${job.suburb_slug}/${job.area_code}/${lid}`, err.message]
          );
        }
      }

      // Update progress after each page
      await pool.query(
        `UPDATE scrape_jobs SET last_page_scraped=$1, total_pages_scraped=total_pages_scraped+1,
         total_listings_found=$2, total_listings_stored=$3, total_listings_skipped=$4 WHERE id=$5`,
        [pg, totalFound, totalStored, totalSkipped, job.id]
      );

    } catch (err) {
      console.error(`    Page error: ${err.message}`);
      if (err.message.includes('503') || err.message.includes('403')) {
        blocked = true;
        break;
      }
    }

    await sleep(delaySec * 1000);
  }

  await page.close();

  if (blocked) {
    await pool.query("UPDATE scrape_jobs SET status='blocked' WHERE id=$1", [job.id]);
    console.log(`  ${job.suburb_name}: BLOCKED after ${totalStored} stored`);
  } else {
    await pool.query("UPDATE scrape_jobs SET status='complete', completed_at=NOW() WHERE id=$1", [job.id]);
    console.log(`  ${job.suburb_name}: COMPLETE — ${totalStored} stored, ${totalSkipped} skipped`);
  }

  return { stored: totalStored, blocked };
}

// ─── Main ──────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--setup')) { await setupJobs(); await showStatus(); await pool.end(); return; }
  if (args.includes('--status')) { await showStatus(); await pool.end(); return; }

  const maxPages = args.includes('--max-pages') ? parseInt(args[args.indexOf('--max-pages') + 1]) : DEFAULT_MAX_PAGES;
  const delaySec = args.includes('--delay') ? parseInt(args[args.indexOf('--delay') + 1]) : DEFAULT_DELAY_SEC;
  const suburbFilter = args.includes('--suburb') ? args[args.indexOf('--suburb') + 1] : null;
  const isRefresh = args.includes('--refresh');

  // Ensure jobs exist
  await setupJobs();

  if (isRefresh) {
    // REFRESH MODE: Reset all complete jobs to start from page 1
    // but the skip logic will skip already-stored listings
    // so it only picks up NEW listings that appeared since last scrape
    console.log('\nREFRESH MODE — scanning for new listings in already-scraped suburbs');
    if (suburbFilter) {
      await pool.query("UPDATE scrape_jobs SET status='pending', last_page_scraped=0, total_pages_scraped=0 WHERE suburb_name ILIKE $1 AND status='complete'", [`%${suburbFilter}%`]);
    } else {
      await pool.query("UPDATE scrape_jobs SET status='pending', last_page_scraped=0, total_pages_scraped=0 WHERE status='complete'");
    }
    // Keep stored/found counts — they're cumulative
  }

  // Get jobs to run
  let jobQuery = "SELECT * FROM scrape_jobs WHERE status IN ('pending', 'in_progress', 'blocked') ORDER BY status, suburb_name";
  const jobParams = [];
  if (suburbFilter) {
    jobQuery = "SELECT * FROM scrape_jobs WHERE suburb_name ILIKE $1 AND status IN ('pending', 'in_progress', 'blocked') ORDER BY suburb_name";
    jobParams.push(`%${suburbFilter}%`);
  }

  const { rows: jobs } = await pool.query(jobQuery, jobParams);
  console.log(`\n${jobs.length} jobs to run (delay: ${delaySec}s, max pages: ${maxPages}${isRefresh ? ', refresh mode' : ''})\n`);

  if (jobs.length === 0) {
    console.log('All jobs complete. Use --setup to re-create or --status to view.');
    await pool.end();
    return;
  }

  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  let grandTotal = 0;

  for (const job of jobs) {
    // Reset blocked jobs to in_progress
    if (job.status === 'blocked') {
      await pool.query("UPDATE scrape_jobs SET status='in_progress' WHERE id=$1", [job.id]);
    }

    const result = await runJob(job, browser, maxPages, delaySec);
    grandTotal += result.stored;

    if (result.blocked) {
      console.log(`\nBlocked by P24 — waiting ${BLOCK_WAIT_SEC}s before next suburb...`);
      await sleep(BLOCK_WAIT_SEC * 1000);
    }
  }

  await browser.close();
  await showStatus();
  await pool.end();
}

main().catch(err => { console.error('Fatal:', err); pool.end(); process.exit(1); });
