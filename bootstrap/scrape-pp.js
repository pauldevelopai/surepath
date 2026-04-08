#!/usr/bin/env node
/**
 * PRIVATEPROPERTY.CO.ZA SCRAPER
 *
 * Scrapes PP listings sorted by most recently uploaded, nationwide.
 * Uses plain HTTP for search pages (fast) and Puppeteer only for
 * individual listing detail pages (needed for price extraction).
 *
 * Default: newest listings first, all provinces. Stops when it
 * hits listings already in the DB (i.e. caught up to last run).
 *
 * Usage:
 *   node bootstrap/scrape-pp.js                                       # Newest first, all SA
 *   node bootstrap/scrape-pp.js --province western-cape               # Filter to one province
 *   node bootstrap/scrape-pp.js --max-pages 100                       # Limit pages
 *   node bootstrap/scrape-pp.js --delay 3                             # Seconds between requests
 *   node bootstrap/scrape-pp.js --no-stop                             # Don't stop when caught up
 *   node bootstrap/scrape-pp.js --status                              # Show progress
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const https = require('https');
const http = require('http');
const pool = require('../db');
const { recordSource } = require('../provenance');

const PROVINCES = {
  'western-cape':   { code: '4', name: 'Western Cape' },
  'gauteng':        { code: '3', name: 'Gauteng' },
  'kwazulu-natal':  { code: '2', name: 'KwaZulu-Natal' },
  'eastern-cape':   { code: '7', name: 'Eastern Cape' },
  'free-state':     { code: '6', name: 'Free State' },
  'mpumalanga':     { code: '8', name: 'Mpumalanga' },
  'limpopo':        { code: '9', name: 'Limpopo' },
  'north-west':     { code: '5', name: 'North West' },
  'northern-cape':  { code: '10', name: 'Northern Cape' },
};

const DEFAULT_DELAY_SEC = 3;
const DEFAULT_MAX_PAGES = 500;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Plain HTTP fetch (no Puppeteer needed for search pages) ──────────

function fetchPage(url) {
  const mod = url.startsWith('https') ? https : http;
  return new Promise((resolve, reject) => {
    const options = {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
    };
    mod.get(url, options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new (require('url').URL)(res.headers.location, url).href;
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

// ─── Extract listing IDs from a search page (plain HTTP) ──────────────

async function getListings(searchUrl) {
  const html = await fetchPage(searchUrl);

  const found = [];
  const seen = new Set();
  // PP listing URLs: /for-sale/{province}/{region}/{city}/{suburb}/.../{T-id}
  const regex = /\/for-sale\/([^"]+?)\/([^"\/]+)\/([^"\/]+)\/([^"\/]+)\/(?:[^"]*\/)?(T\d+)/g;
  let m;
  while ((m = regex.exec(html)) !== null) {
    if (seen.has(m[5])) continue;
    seen.add(m[5]);
    // Extract province from the first path segment
    const provincePath = m[1].split('/')[0];
    found.push({
      id: m[5],
      url: `https://www.privateproperty.co.za/for-sale/${m[1]}/${m[2]}/${m[3]}/${m[4]}/${m[5]}`,
      province: provincePath,
      city_region: m[2],
      area: m[3],
      suburb: m[4],
    });
  }
  return found;
}

// ─── Extract ALL data from a single listing (plain HTTP, no Puppeteer) ──

async function extractListing(_unused, url) {
  const html = await fetchPage(url);
  const r = { photos: [] };
  const bodyText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  // Title — h1
  const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  r.title = h1Match ? h1Match[1].trim() : null;

  // JSON-LD — beds, baths, garages, address, photo
  const jsonldBlocks = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of jsonldBlocks) {
    try {
      const jsonStr = block.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '');
      const ld = JSON.parse(jsonStr);
      if (ld.additionalProperty) {
        for (const p of ld.additionalProperty) {
          if (p.name === 'Bedrooms' && !r.bedrooms) r.bedrooms = parseInt(p.value);
          if (p.name === 'Bathrooms' && !r.bathrooms) r.bathrooms = parseInt(p.value);
          if (p.name === 'Garages' && !r.parking) r.parking = parseInt(p.value);
        }
      }
    } catch {}
  }

  // Fallback features from body text
  if (!r.bedrooms) { const m = bodyText.match(/(\d+)\s*Bed/i); r.bedrooms = m ? parseInt(m[1]) : null; }
  if (!r.bathrooms) { const m = bodyText.match(/(\d+)\s*Bath/i); r.bathrooms = m ? parseInt(m[1]) : null; }
  if (!r.parking) { const m = bodyText.match(/(\d+)\s*(?:Parking|Garage)/i); r.parking = m ? parseInt(m[1]) : null; }
  const sqmMatch = bodyText.match(/(\d+)\s*m²/);
  r.floor_area = sqmMatch ? parseInt(sqmMatch[1]) : null;
  const erfMatch = bodyText.match(/Erf Size[:\s]*(\d[\d\s]*)\s*m²/i);
  r.erf_size = erfMatch ? parseInt(erfMatch[1].replace(/\s/g, '')) : null;

  // Price — PP renders price client-side, but sometimes it's in the static HTML
  const priceMatch = bodyText.match(/R\s*([\d\s]+\d{3})/);
  r.price = priceMatch ? parseInt(priceMatch[1].replace(/\s/g, '')) : null;
  // Validate — small numbers are not prices
  if (r.price && r.price < 50000) r.price = null;

  // Listing date — look for date patterns in the page
  const dateMatch = html.match(/(?:Listed|Published|Date)[:\s]*(\d{1,2}[\s/-]\w{3,9}[\s/-]\d{4})/i)
    || html.match(/(\d{4}-\d{2}-\d{2})T/); // ISO format in JSON-LD
  r.listing_date = dateMatch ? dateMatch[1] : null;

  // Listing status — detect sold/under offer badges
  const statusLower = html.toLowerCase();
  if (statusLower.includes('sold') && (statusLower.includes('status-sold') || statusLower.includes('badge-sold') || statusLower.includes('>sold<'))) r.listing_status = 'sold';
  else if (statusLower.includes('under offer') || statusLower.includes('offer accepted')) r.listing_status = 'under_offer';
  else if (statusLower.includes('price reduced') || statusLower.includes('price drop')) r.listing_status = 'price_reduced';
  else r.listing_status = 'active';

  // Levies and rates
  const levyMatch = bodyText.match(/Lev(?:y|ies)[:\s]*R\s*([\d\s]+)/i);
  const rateMatch = bodyText.match(/Rates[:\s]*R\s*([\d\s]+)/i);
  r.levies = levyMatch ? parseInt(levyMatch[1].replace(/\s/g, '')) : null;
  r.rates = rateMatch ? parseInt(rateMatch[1].replace(/\s/g, '')) : null;

  // Property type
  const typeText = bodyText.toLowerCase();
  if (typeText.includes('apartment') || typeText.includes('flat')) r.property_type = 'sectional';
  else if (typeText.includes('house') && !typeText.includes('townhouse')) r.property_type = 'freehold';
  else if (typeText.includes('townhouse') || typeText.includes('cluster')) r.property_type = 'estate';
  else r.property_type = null;

  // Booleans
  r.pet_friendly = /pet[s]?\s*(?:allowed|friendly)/i.test(bodyText);
  r.furnished = /\bfurnished\b/i.test(bodyText);

  // Description
  const descMatch = html.match(/<[^>]*class="[^"]*(?:description|listing-body)[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i);
  r.description = descMatch ? descMatch[1].replace(/<[^>]+>/g, '').trim().substring(0, 3000) : null;

  // Agent
  const agentMatch = html.match(/<[^>]*class="[^"]*(?:agent-name|consultant)[^"]*"[^>]*>([^<]+)<\/[^>]+>/i);
  r.agent_name = agentMatch ? agentMatch[1].trim() : null;
  const agencyMatch = html.match(/<[^>]*class="[^"]*(?:agency-name|brand-name)[^"]*"[^>]*>([^<]+)<\/[^>]+>/i);
  r.agency_name = agencyMatch ? agencyMatch[1].trim() : null;

  // Photos — scan entire HTML for PP image CDN URLs
  const photoSeen = new Set();
  const imgRegex = /images\.pp\.co\.za\/listing\/(\d+)\/([A-Za-z0-9_-]+)/g;
  let imgM;
  while ((imgM = imgRegex.exec(html)) !== null) {
    if (!photoSeen.has(imgM[2])) {
      photoSeen.add(imgM[2]);
      r.photos.push(`https://images.pp.co.za/listing/${imgM[1]}/${imgM[2]}/1600/1066/contain/jpegorpng`);
    }
    if (r.photos.length >= 16) break;
  }

  return r;
}

// ─── Store listing ─────────────────────────────────────────────────────

async function storeListing(listing, meta, listingUrl) {
  const erfNumber = `PP_${meta.id}`;

  // Check if already stored — update key fields if so (price, status, last_checked)
  const { rows: existing } = await pool.query('SELECT id, asking_price, listing_status FROM properties WHERE erf_number = $1', [erfNumber]);
  if (existing.length > 0) {
    const prop = existing[0];
    const newStatus = listing.listing_status || 'active';
    const priceChanged = listing.price && prop.asking_price && listing.price !== prop.asking_price;
    const statusChanged = newStatus !== (prop.listing_status || 'active');

    // Track price changes
    if (priceChanged) {
      await pool.query(
        "UPDATE properties SET price_history = COALESCE(price_history, '[]'::jsonb) || $1::jsonb WHERE id = $2",
        [JSON.stringify([{ price: prop.asking_price, date: new Date().toISOString().split('T')[0], event: 'price_change' }]), prop.id]
      );
    }

    // Update the listing
    await pool.query(
      `UPDATE properties SET
        asking_price = COALESCE($1, asking_price),
        listing_status = $2,
        last_checked_at = NOW(),
        last_scraped_at = NOW()
        ${statusChanged ? ", status_changed_at = NOW()" : ""}
      WHERE id = $3`,
      [listing.price || null, newStatus, prop.id]
    );

    if (priceChanged) console.log(`  PRICE CHANGE: ${erfNumber} R${prop.asking_price} → R${listing.price}`);
    if (statusChanged) console.log(`  STATUS CHANGE: ${erfNumber} ${prop.listing_status} → ${newStatus}`);

    return { id: prop.id, skipped: true, updated: priceChanged || statusChanged };
  }

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
      listing_image_url, last_scraped_at, listing_status, listing_date, first_scraped_at, last_checked_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,NOW(),$23,$24,NOW(),NOW())
    ON CONFLICT (erf_number) DO NOTHING RETURNING id`,
    [
      erfNumber, title, suburb, cityRegion, province,
      listing.property_type, listing.floor_area, listing.erf_size, listing.bedrooms, listing.bathrooms,
      meta.id, listingUrl, listing.price,
      listing.levies, listing.rates, listing.parking,
      listing.pet_friendly || null, listing.furnished || null, listing.description,
      listing.agent_name, listing.agency_name,
      listing.photos[0] || null,
      listing.listing_status || 'active',
      listing.listing_date || null,
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
      "INSERT INTO property_images (property_id, source, image_url, image_type) VALUES ($1, 'privateproperty', $2, 'listing') ON CONFLICT (property_id, image_url) DO NOTHING",
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
    const { rows: newest } = await pool.query("SELECT created_at FROM properties WHERE erf_number LIKE 'PP_%' ORDER BY created_at DESC LIMIT 1");
    console.log(`PrivateProperty: ${pp[0].c} properties, ${imgs[0].c} images`);
    if (newest.length > 0) console.log(`Last scraped: ${newest[0].created_at}`);
    await pool.end();
    return;
  }

  // Province filter is now optional — default is nationwide
  const provinceKey = args.includes('--province') ? args[args.indexOf('--province') + 1] : null;
  const maxPages = args.includes('--max-pages') ? parseInt(args[args.indexOf('--max-pages') + 1]) : DEFAULT_MAX_PAGES;
  const delaySec = args.includes('--delay') ? parseInt(args[args.indexOf('--delay') + 1]) : DEFAULT_DELAY_SEC;
  const startPage = args.includes('--start-page') ? parseInt(args[args.indexOf('--start-page') + 1]) : 1;
  const stopWhenCaughtUp = !args.includes('--no-stop');

  // Build base search URL — nationwide or filtered by province
  let basePath, label;
  if (provinceKey && PROVINCES[provinceKey]) {
    basePath = `/for-sale/${provinceKey}/${PROVINCES[provinceKey].code}`;
    label = PROVINCES[provinceKey].name;
  } else {
    basePath = '/for-sale/south-africa/1';
    label = 'All South Africa';
  }

  console.log(`\nScraping PrivateProperty — ${label}`);
  console.log(`Delay ${delaySec}s, max ${maxPages} pages`);
  console.log(`No Puppeteer — all extraction via plain HTTP`);
  console.log();

  let totalStored = 0;
  let totalSkipped = 0;
  let totalPhotos = 0;

  // Helper: scrape a range of pages, returns the page number where it stopped
  async function scrapePages(fromPage, toPage, stopOnCaughtUp) {
    let emptyPages = 0;
    let caughtUpPages = 0;
    let lastPage = fromPage;

    for (let pg = fromPage; pg <= toPage; pg++) {
      lastPage = pg;
      const searchUrl = `https://www.privateproperty.co.za${basePath}?page=${pg}&so=MostRecent`;
      console.log(`[page ${pg}] ${searchUrl}`);

      try {
        const listings = await getListings(searchUrl);
        console.log(`  ${listings.length} listings`);

        if (listings.length === 0) {
          emptyPages++;
          if (emptyPages >= 3) { console.log('  3 empty pages in a row — done'); return lastPage; }
          continue;
        }
        emptyPages = 0;

        let pageNewCount = 0;
        let pageSkipCount = 0;

        for (const meta of listings) {
          const { rows: exists } = await pool.query("SELECT id FROM properties WHERE erf_number = $1", [`PP_${meta.id}`]);
          if (exists.length > 0) { totalSkipped++; pageSkipCount++; continue; }

          try {
            await sleep(delaySec * 1000);
            const listing = await extractListing(null, meta.url);

            if (!listing.title && !listing.price) {
              console.log(`    SKIP ${meta.id} — empty page`);
              continue;
            }

            const result = await storeListing(listing, meta, meta.url);
            if (result.skipped) {
              totalSkipped++;
              pageSkipCount++;
            } else {
              totalStored++;
              pageNewCount++;
              totalPhotos += result.photos || 0;
              const priceStr = listing.price ? `R${listing.price.toLocaleString()}` : '-';
              console.log(`    NEW #${result.id} ${listing.title || 'untitled'} | ${priceStr} | ${listing.bedrooms || '?'}bed | ${result.photos}pho`);
            }
          } catch (err) {
            console.error(`    ERROR ${meta.id}: ${err.message}`);
          }
        }

        console.log(`  → ${pageNewCount} new, ${pageSkipCount} skipped`);

        if (stopOnCaughtUp && pageNewCount === 0 && pageSkipCount > 0) {
          caughtUpPages++;
          if (caughtUpPages >= 2) {
            console.log(`  Caught up — no new listings for ${caughtUpPages} pages.`);
            return lastPage;
          }
        } else {
          caughtUpPages = 0;
        }
      } catch (err) {
        console.error(`  Page error: ${err.message}`);
      }

      if (pg % 10 === 0) {
        console.log(`\n  --- Page ${pg}: ${totalStored} stored, ${totalSkipped} skipped, ${totalPhotos} photos ---\n`);
      }

      await sleep(delaySec * 1000);
    }

    return lastPage;
  }

  // ── PHASE 1: Catch up on new listings (pages 1-N, stop when caught up) ──
  if (startPage === 1) {
    console.log(`=== PHASE 1: New listings sweep ===`);
    const catchUpEnd = await scrapePages(1, Math.min(50, maxPages), true);
    console.log(`  New listings sweep finished at page ${catchUpEnd} — ${totalStored} new so far\n`);
  }

  // ── PHASE 2: Backfill from bookmark (deep scrape into older listings) ──
  // Load bookmark — the deepest page we've reached in previous runs
  const { rows: bookmarkRows } = await pool.query(
    "SELECT value FROM scraper_state WHERE key = 'pp_backfill_page' LIMIT 1"
  ).catch(() => ({ rows: [] }));
  let backfillPage = bookmarkRows.length > 0 ? parseInt(bookmarkRows[0].value) : startPage;
  if (startPage > 1) backfillPage = startPage; // manual override

  // Skip phase 2 if we've already been told to stop early
  if (!stopWhenCaughtUp || startPage > 1) {
    console.log(`=== PHASE 2: Backfill from page ${backfillPage} ===`);
    const endPage = await scrapePages(backfillPage, maxPages, false);

    // Save bookmark for next run
    try {
      await pool.query(
        `INSERT INTO scraper_state (key, value, updated_at) VALUES ('pp_backfill_page', $1, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
        [String(endPage + 1)]
      );
      console.log(`  Bookmark saved: will resume from page ${endPage + 1} next run`);
    } catch {
      // scraper_state table might not exist yet — create it
      try {
        await pool.query(`CREATE TABLE IF NOT EXISTS scraper_state (key TEXT PRIMARY KEY, value TEXT, updated_at TIMESTAMPTZ DEFAULT NOW())`);
        await pool.query(
          `INSERT INTO scraper_state (key, value) VALUES ('pp_backfill_page', $1) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
          [String(endPage + 1)]
        );
        console.log(`  Bookmark saved: will resume from page ${endPage + 1} next run`);
      } catch (e) { console.log(`  Could not save bookmark: ${e.message}`); }
    }
  }

  console.log(`\n=== PP SCRAPE COMPLETE ===`);
  console.log(`  Scope: ${label}`);
  console.log(`  New properties: ${totalStored}`);
  console.log(`  Photos stored: ${totalPhotos}`);
  console.log(`  Skipped (already in DB): ${totalSkipped}`);

  const { rows: total } = await pool.query("SELECT COUNT(*) AS c FROM properties");
  const { rows: ppTotal } = await pool.query("SELECT COUNT(*) AS c FROM properties WHERE erf_number LIKE 'PP_%'");
  console.log(`  DB total: ${total[0].c} properties (${ppTotal[0].c} from PP)`);

  await pool.end();
}

main().catch(err => { console.error('Fatal:', err); pool.end(); process.exit(1); });
