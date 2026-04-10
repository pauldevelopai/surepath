const https = require('https');
const http = require('http');
const Anthropic = require('@anthropic-ai/sdk');
const pool = require('./db');
const maps = require('./maps');
const windeed = require('./windeed');
const vision = require('./vision');
const { synthesiseReport } = require('./synthesis');
const { renderReport, renderPropertyPDF, exportInspectPagePDF } = require('./pdf');

const anthropicClient = new Anthropic();

// ─── Logging ───────────────────────────────────────────────────────────

function log(step, message) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] STEP ${step.toString().padStart(2, '0')} — ${message}`);
}

// ─── Property24 scraping ───────────────────────────────────────────────

function fetchHTML(url) {
  // Route Property24 requests through ScraperAPI proxy (free: 5K requests/month)
  // P24 blocks our server IP directly with 503
  const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY;
  if (url.includes('property24.com') && SCRAPER_API_KEY) {
    const proxyUrl = `https://api.scraperapi.com?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(url)}`;
    console.log(`[fetch] Routing P24 through ScraperAPI proxy`);
    // Log the ScraperAPI usage
    try { const { logCost } = require('./costs'); logCost('scraperapi', 'property24_fetch', 0.001, null, { url }); } catch {}
    return new Promise((resolve, reject) => {
      https.get(proxyUrl, { headers: { 'Accept': 'text/html' }, timeout: 30000 }, (res) => {
        if (res.statusCode !== 200) return reject(new Error(`ScraperAPI returned ${res.statusCode} for ${url}`));
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => resolve(body));
        res.on('error', reject);
      }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('ScraperAPI timeout')); });
    });
  }

  const mod = url.startsWith('https') ? https : http;
  const parsed = new (require('url').URL)(url);
  const options = {
    hostname: parsed.hostname,
    path: parsed.pathname + parsed.search,
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' },
    timeout: 20000,
  };
  return new Promise((resolve, reject) => {
    mod.get(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new (require('url').URL)(res.headers.location, url).href;
        return fetchHTML(redirectUrl).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
      }
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => resolve(body));
      res.on('error', reject);
    }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error(`Timeout fetching ${url}`)); });
  });
}

function isProperty24URL(input) {
  return /property24\.com/i.test(input);
}

function extractProperty24Data(html) {
  // Extract photo CDN URLs from img tags
  const photoUrls = [];
  const imgRegex = /<img[^>]+src=["']([^"']*(?:property24|p24)[^"']*\.(?:jpg|jpeg|png|webp)[^"']*)["'][^>]*>/gi;
  let match;
  while ((match = imgRegex.exec(html)) !== null) {
    const url = match[1];
    if (!photoUrls.includes(url) && !url.includes('logo') && !url.includes('icon')) {
      photoUrls.push(url.startsWith('//') ? 'https:' + url : url);
    }
  }

  // Also check for data-src (lazy-loaded images)
  const dataSrcRegex = /data-src=["']([^"']*(?:property24|p24|imgix)[^"']*\.(?:jpg|jpeg|png|webp)[^"']*)["']/gi;
  while ((match = dataSrcRegex.exec(html)) !== null) {
    const url = match[1];
    if (!photoUrls.includes(url) && !url.includes('logo') && !url.includes('icon')) {
      photoUrls.push(url.startsWith('//') ? 'https:' + url : url);
    }
  }

  // Extract address — look for common Property24 patterns
  let address = null;
  // Try structured data (JSON-LD)
  const jsonldMatch = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
  if (jsonldMatch) {
    try {
      const ld = JSON.parse(jsonldMatch[1]);
      if (ld.address) {
        address = [ld.address.streetAddress, ld.address.addressLocality, ld.address.addressRegion]
          .filter(Boolean).join(', ');
      }
    } catch (e) { /* ignore parse errors */ }
  }

  // Fallback: title tag often has address
  if (!address) {
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch) {
      // Property24 titles are like "3 Bedroom House for Sale in Gardens - ..."
      const title = titleMatch[1];
      const addrMatch = title.match(/(?:for\s+sale|to\s+rent)\s+in\s+(.+?)(?:\s*[-–|]|$)/i);
      if (addrMatch) address = addrMatch[1].trim();
    }
  }

  // Fallback: h1 tag
  if (!address) {
    const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
    if (h1Match) address = h1Match[1].trim();
  }

  return { photoUrls, address };
}

// ─── PrivateProperty scraping ──────────────────────────────────────────

function isPrivatePropertyURL(input) {
  return /privateproperty\.co\.za|(?<![a-z])pp\.co\.za/i.test(input);
}

async function extractPrivatePropertyData(url) {
  try {
    const html = await fetchHTML(url);

    // Listing ID from URL
    const listingIdMatch = url.match(/(T\d+)/);
    const listingId = listingIdMatch ? listingIdMatch[1] : null;

    // Photos — find images.pp.co.za/listing/{listingId}/{imageId} in raw HTML
    const photoUrls = [];
    const photoSeen = new Set();
    const ppImgRegex = /images\.pp\.co\.za\/listing\/(\d+)\/([A-Za-z0-9_-]+)/g;
    let match;
    while ((match = ppImgRegex.exec(html)) !== null) {
      if (!photoSeen.has(match[2])) {
        photoSeen.add(match[2]);
        photoUrls.push(`https://images.pp.co.za/listing/${match[1]}/${match[2]}/1600/1066/contain/jpegorpng`);
      }
      if (photoUrls.length >= 16) break;
    }

    // Address — try JSON-LD first
    let address = null;
    const jsonldMatches = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
    if (jsonldMatches) {
      for (const block of jsonldMatches) {
        try {
          const jsonStr = block.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '');
          const ld = JSON.parse(jsonStr);
          const items = ld['@graph'] || [ld];
          for (const item of items) {
            // PP uses @type Residence (not RealEstateListing)
            const addr = item.about?.address || item.address;
            if (addr && addr.streetAddress) {
              address = [addr.streetAddress, addr.addressLocality, addr.addressRegion].filter(Boolean).join(', ');
              if (address) break;
            }
          }
        } catch {}
        if (address) break;
      }
    }

    // Fallback: h1
    if (!address) {
      const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
      if (h1Match) address = h1Match[1].trim();
    }

    // Fallback: title tag — PP titles: "X Bedroom House for Sale in Suburb"
    if (!address) {
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      if (titleMatch) {
        const addrMatch = titleMatch[1].match(/(?:for\s+sale|to\s+rent)\s+in\s+(.+?)(?:\s*[-–|]|$)/i);
        if (addrMatch) address = addrMatch[1].trim();
      }
    }

    // Strip HTML from body for text matching
    const bodyText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

    // Asking price — PP renders price client-side, try Puppeteer
    let askingPrice = null;
    try {
      const puppeteer = require('puppeteer');
      const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
      const page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
      await page.goto(url, { waitUntil: 'networkidle0', timeout: 20000 });
      const priceText = await page.evaluate(() => {
        // Look for price elements
        const priceEl = document.querySelector('[class*="price"], [class*="Price"], [data-testid*="price"]');
        if (priceEl) return priceEl.textContent;
        // Fallback: find any element containing "R" followed by digits
        const all = document.querySelectorAll('span, div, p, h2, h3');
        for (const el of all) {
          const t = el.textContent?.trim() || '';
          if (/^R\s*[\d\s,]+$/.test(t) && t.replace(/\D/g, '').length >= 6) return t;
        }
        return null;
      });
      await browser.close();
      if (priceText) {
        const parsed = parseInt(priceText.replace(/\D/g, ''));
        if (parsed >= 50000) askingPrice = parsed;
      }
    } catch (err) {
      console.error(`[pp] Puppeteer price extraction error: ${err.message}`);
    }

    // Fallback: static HTML price
    if (!askingPrice) {
      const priceMatch = bodyText.match(/R\s*([\d\s,]+)/);
      if (priceMatch) {
        const parsed = parseInt(priceMatch[1].replace(/[\s,]/g, ''));
        if (parsed >= 50000) askingPrice = parsed;
      }
    }

    // Bedrooms, bathrooms, floor area — also try JSON-LD additionalProperty
    let bedrooms = null, bathrooms = null, floorArea = null;
    if (jsonldMatches) {
      for (const block of jsonldMatches) {
        try {
          const jsonStr = block.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '');
          const ld = JSON.parse(jsonStr);
          const props = ld.additionalProperty || [];
          for (const p of props) {
            if (p.name === 'Bedrooms') bedrooms = parseInt(p.value);
            if (p.name === 'Bathrooms') bathrooms = parseInt(p.value);
          }
        } catch {}
      }
    }
    const bedsMatch = bodyText.match(/(\d+)\s*Bed/i);
    const bathsMatch = bodyText.match(/(\d+)\s*Bath/i);
    const areaMatch = bodyText.match(/(\d+)\s*m²/);
    if (!bedrooms && bedsMatch) bedrooms = parseInt(bedsMatch[1]);
    if (!bathrooms && bathsMatch) bathrooms = parseInt(bathsMatch[1]);

    // Property type
    let propertyType = null;
    const lower = bodyText.toLowerCase();
    if (lower.includes('apartment') || lower.includes('flat')) propertyType = 'sectional';
    else if (lower.includes('townhouse') || lower.includes('cluster')) propertyType = 'estate';
    else if (lower.includes('house') && !lower.includes('townhouse')) propertyType = 'freehold';

    // Description
    let description = null;
    const descMatch = html.match(/<[^>]*class="[^"]*(?:description|listing-body)[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i);
    if (descMatch) {
      description = descMatch[1].replace(/<[^>]+>/g, '').trim().substring(0, 1000) || null;
    }

    return {
      photoUrls,
      address,
      askingPrice,
      bedrooms: bedrooms || null,
      bathrooms: bathrooms || null,
      floorAreaSqm: areaMatch ? parseInt(areaMatch[1]) : null,
      propertyType,
      description,
      listingId,
    };
  } catch (err) {
    console.error(`[pipeline] extractPrivatePropertyData error: ${err.message}`);
    return null;
  }
}

// ─── Tease generation ─────────────────────────────────────────────────

async function generateTease(extractedData) {
  try {
    // Step 1: Take first 3 photos
    const photoSlice = (extractedData.photoUrls || []).slice(0, 3);
    let topRiskFlags = [];
    let hasAsbestosRisk = false;
    let hasStructuralFlags = false;
    let nicoTease = null; // will be generated from photos or listing data

    if (photoSlice.length > 0) {
      // Step 2: Download and encode images
      const images = [];
      for (const url of photoSlice) {
        try {
          const buffer = await vision.downloadImage(url);
          const mediaType = url.includes('.png') ? 'image/png' : 'image/jpeg';
          images.push({ base64: buffer.toString('base64'), mediaType, url });
        } catch (err) {
          console.error(`[tease] Download failed: ${err.message}`);
        }
      }

      if (images.length > 0) {
        try {
          // Step 3: Run vision analysis on the batch
          const analyses = await vision.analyseBatch(images);

          // Step 4: Extract top risk flags
          const allFindings = [];
          for (const a of analyses) {
            if (Array.isArray(a.findings)) allFindings.push(...a.findings);
          }

          topRiskFlags = allFindings
            .filter(f => f.severity === 'CRITICAL' || f.severity === 'HIGH')
            .map(f => f.observation)
            .filter(Boolean)
            .slice(0, 3);

          // Step 5: Check asbestos and structural flags
          hasAsbestosRisk = analyses.some(a => a.asbestos_indicators === true);
          hasStructuralFlags = allFindings.some(f =>
            (f.category === 'structure' || f.category === 'walls') &&
            (f.severity === 'CRITICAL' || f.severity === 'HIGH')
          );

          // Step 6: Generate Nico tease via Claude
          const flagsText = topRiskFlags.length > 0
            ? topRiskFlags.join('; ')
            : 'none found in first 3 photos';

          const { getModel } = require('./model-config');
          const message = await anthropicClient.messages.create({
            model: getModel('tease'),
            max_tokens: 150,
            system: "You are Nico, a South African ex-property agent with 20 years experience, aged 38-42. Calm, direct, slightly contrarian. Write exactly 2 sentences for a potential buyer about this property. Rules: NEVER say 'no red flags' or 'nothing jumped out' or 'looks clean' — that kills curiosity. NEVER mention photos, street view, or what you can/cannot see. NEVER mention the report, Surepath, deeds, or crime stats. Instead: make a specific, interesting observation about the property — comment on the price vs area, the size, the layout implied by bedrooms/bathrooms, the suburb's reputation, or what a smart buyer should ask about. If risk flags were found, reference them directly. Be conversational South African English. Make the buyer want to know more.",
            messages: [{
              role: 'user',
              content: `Property: ${extractedData.address || 'unknown address'}. Asking price: R${extractedData.askingPrice ? extractedData.askingPrice.toLocaleString('en-ZA') : 'unknown'}. Top risk flags from photo analysis: ${flagsText}.`,
            }],
          });

          nicoTease = message.content[0].text;

          // Log cost
          try {
            const { logClaude } = require('./costs');
            await logClaude(getModel('tease'), message.usage.input_tokens, message.usage.output_tokens, 'tease/nico');
          } catch {}
        } catch (visionErr) {
          console.error(`[tease] Vision/Claude tease failed: ${visionErr.message} — falling back to listing data`);
          // nicoTease stays null → listing-data fallback below will handle it
        }
      }
    }

    // If no tease was generated from photos, generate from listing data
    if (!nicoTease) {
      try {
        const priceStr = extractedData.askingPrice ? `R${extractedData.askingPrice.toLocaleString('en-ZA')}` : 'unknown price';
        const bedsStr = extractedData.bedrooms ? `${extractedData.bedrooms} bedroom` : '';
        const locationStr = extractedData.address || 'this area';
        const resp = await anthropicClient.messages.create({
          model: getModel('tease'),
          max_tokens: 150,
          system: "You are Nico, a South African ex-property agent with 20 years experience, aged 38-42. Calm, direct, slightly contrarian. Write exactly 2 sentences for a potential buyer about this property. Rules: NEVER say 'no red flags' or 'nothing jumped out' or 'looks clean' — that kills curiosity. NEVER mention photos, street view, or what you can/cannot see. NEVER mention the report, Surepath, deeds, or crime stats. Instead: make a specific, interesting observation about the property — comment on the price vs area, the size, the layout implied by bedrooms/bathrooms, the suburb's reputation, or what a smart buyer should ask about. If risk flags were found, reference them directly. Be conversational South African English. Make the buyer want to know more.",
          messages: [{ role: 'user', content: `Property: ${bedsStr} property at ${locationStr}. Asking ${priceStr}.` }],
        });
        nicoTease = resp.content[0].text;
      } catch {
        nicoTease = `${extractedData.bedrooms || ''}bed property at ${extractedData.address || 'this location'} for ${extractedData.askingPrice ? 'R' + extractedData.askingPrice.toLocaleString('en-ZA') : 'an undisclosed price'}. Get the full report for deeds, crime stats, and infrastructure data.`;
      }
    }

    return {
      address: extractedData.address,
      askingPrice: extractedData.askingPrice,
      bedrooms: extractedData.bedrooms,
      bathrooms: extractedData.bathrooms,
      topRiskFlags,
      hasAsbestosRisk,
      hasStructuralFlags,
      nicoTease,
      photoCount: (extractedData.photoUrls || []).length,
    };
  } catch (err) {
    console.error(`[tease] Error: ${err.message}`);
    // Even if everything failed, generate something useful from listing data
    const addr = extractedData.address || 'this property';
    const beds = extractedData.bedrooms ? `${extractedData.bedrooms} bed` : '';
    const price = extractedData.askingPrice ? `R${extractedData.askingPrice.toLocaleString('en-ZA')}` : '';
    const details = [beds, price].filter(Boolean).join(' at ');
    const fallbackTease = details
      ? `${details} in ${addr} — worth a closer look. The full report covers deeds history, crime stats, structural risks, and compliance flags so you know exactly what you're getting into.`
      : `The full report covers deeds history, crime stats, structural risks, and compliance flags for ${addr} — everything you need before making an offer.`;
    return {
      address: extractedData.address,
      askingPrice: extractedData.askingPrice,
      bedrooms: extractedData.bedrooms,
      bathrooms: extractedData.bathrooms,
      topRiskFlags: [],
      hasAsbestosRisk: false,
      hasStructuralFlags: false,
      nicoTease: fallbackTease,
      photoCount: (extractedData.photoUrls || []).length,
    };
  }
}

// ─── Main pipeline ─────────────────────────────────────────────────────

/**
 * Generate a complete Surepath property report.
 *
 * @param {string} input - Property24 URL or address string
 * @param {number} askingPrice - Asking price in ZAR
 * @param {string} phoneNumber - Buyer's phone number
 * @returns {{ report_id, pdf_url, decision, decision_reasoning, was_resale }}
 */
async function generateReport(input, askingPrice, phoneNumber) {
  let address = null;
  let photoUrls = [];
  let propertyId = null;
  let reportId = null;

  try {
    // ── STEP 01: Property resolution ────────────────────────────────
    log(1, 'Property resolution');

    if (isProperty24URL(input)) {
      // Check if we already have this property (created by tease) — skip re-fetching P24
      const cleanP24 = input.replace(/[?#].*$/, '').replace(/\/+$/, '');
      const { rows: existingP24 } = await pool.query(
        "SELECT id, address_raw, suburb, city, province, asking_price, bedrooms, bathrooms FROM properties WHERE listing_url ILIKE $1 ORDER BY id DESC LIMIT 1",
        [`%${cleanP24.split('/').pop()}%`]
      );
      if (existingP24.length > 0) {
        const ep = existingP24[0];
        propertyId = ep.id;
        address = ep.address_raw;
        if (!askingPrice && ep.asking_price) askingPrice = ep.asking_price;
        log(1, `Found existing P24 property ${propertyId} — skipping P24 re-fetch (saves ScraperAPI call)`);
        // Check if it has photos already
        const { rows: photoCheck } = await pool.query(
          "SELECT COUNT(*) as c FROM property_images WHERE property_id = $1 AND source IN ('property24','privateproperty') AND image_url LIKE 'http%'",
          [propertyId]
        );
        if (parseInt(photoCheck[0].c) > 0) {
          log(1, `Already have ${photoCheck[0].c} photos — using existing`);
        }
      }

      if (!propertyId) {
      log(1, `Property24 URL — extracting OG metadata: ${input}`);
      let html = null;
      try {
        html = await fetchHTML(input);
      } catch (fetchErr) {
        log(1, `P24 fetch failed (${fetchErr.message}) — matching via URL path`);
        // Extract suburb/city from URL and find PP match
        const p24UrlParts = input.match(/property24\.com\/for-sale\/([^/]+)\/([^/]+)\/([^/]+)/);
        if (p24UrlParts) {
          const p24Sub = p24UrlParts[1].replace(/-/g, ' ');
          const p24City = p24UrlParts[2].replace(/-/g, ' ');
          // No PP match — continue with P24 URL, will try ScraperAPI on retry
          log(1, `No PP match for ${p24Sub}, ${p24City} — P24 also failed: ${fetchErr.message}`);
          throw new Error(`Could not fetch Property24 listing (${fetchErr.message}). The property may have been removed.`);
        } else {
          throw fetchErr;
        }
      }
      if (!html) {
        // Already handled via PP match above — skip P24 OG extraction
      } else {

      // Extract OG meta tags (reliable from static HTML, unlike photos which need JS)
      const ogImage = (html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
                       html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i) || [])[1] || null;
      const ogTitle = (html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
                       html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i) || [])[1] || null;

      // Try to find the PP equivalent — local DB first, Vision API as fallback
      // P24 URL: /for-sale/{suburb}/{city}/{province}/{code}/{id}
      const p24UrlParts = input.match(/property24\.com\/for-sale\/([^/]+)\/([^/]+)\/([^/]+)/);
      const p24Suburb = p24UrlParts ? p24UrlParts[1].replace(/-/g, ' ') : null;
      const p24City = p24UrlParts ? p24UrlParts[2].replace(/-/g, ' ') : null;
      const p24Beds = ogTitle ? parseInt((ogTitle.match(/(\d+)\s*Bed/i) || [])[1]) || null : null;

      // Extract street address from OG title or JSON-LD
      let p24Street = null;
      try {
        const jsonldMatches = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
        for (const block of jsonldMatches) {
          const jsonStr = block.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '');
          const ld = JSON.parse(jsonStr);
          if (ld.address?.streetAddress) { p24Street = ld.address.streetAddress; break; }
        }
      } catch {}
      if (!p24Street && ogTitle) {
        const titleParts = ogTitle.replace(/\s*-\s*Property24.*$/i, '').split(/\s*-\s*/);
        if (titleParts.length >= 3) p24Street = titleParts.slice(1, -1).join(', ');
      }

      let ppResolved = false;

      // Strategy 1: Local DB — street address match in PP listing URL
      if (p24Street && p24Suburb) {
        const streetNorm = p24Street.toLowerCase().replace(/\s+street$/i, '').replace(/\s+road$/i, '').replace(/\s+avenue$/i, '').replace(/\s+drive$/i, '').trim().replace(/\s+/g, '-');
        const ordinals = { first: '1st', second: '2nd', third: '3rd', fourth: '4th', fifth: '5th', sixth: '6th', seventh: '7th', eighth: '8th', ninth: '9th', tenth: '10th' };
        const streetOrdinal = streetNorm.replace(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/g, m => ordinals[m]);

        log(1, `Searching local DB for street "${streetOrdinal}" in ${p24Suburb}`);
        for (const pattern of [streetOrdinal, streetNorm]) {
          if (ppResolved) break;
          const { rows } = await pool.query(
            `SELECT id, listing_url, address_raw, bedrooms FROM properties
             WHERE erf_number LIKE 'PP_%' AND listing_url ILIKE $1
             AND (suburb ILIKE $2 OR listing_url ILIKE $3)
             ORDER BY id DESC LIMIT 5`,
            [`%/${pattern}/%`, p24Suburb, `%/${p24Suburb.toLowerCase().replace(/\s+/g, '-')}/%`]
          );
          if (rows.length > 0) {
            const best = (p24Beds && rows.length > 1) ? (rows.find(r => r.bedrooms === p24Beds) || rows[0]) : rows[0];
            const ppData = await extractPrivatePropertyData(best.listing_url);
            if (ppData?.address) {
              photoUrls = ppData.photoUrls || [];
              address = ppData.address;
              if (!askingPrice && ppData.askingPrice) askingPrice = ppData.askingPrice;
              input = best.listing_url;
              ppResolved = true;
              log(1, `LOCAL DB MATCH (street): ${best.listing_url} → ${photoUrls.length} photos, "${address}"`);
            }
          }
        }
      }

      // Strategy 2: Local DB — suburb + beds + price (only if unique)
      if (!ppResolved && p24Suburb && p24Beds) {
        const priceClause = askingPrice ? 'AND asking_price BETWEEN $3 * 0.85 AND $3 * 1.15' : '';
        const params = askingPrice ? [p24Suburb, p24Beds, askingPrice] : [p24Suburb, p24Beds];
        const { rows } = await pool.query(
          `SELECT id, listing_url, address_raw, bedrooms FROM properties
           WHERE erf_number LIKE 'PP_%' AND (suburb ILIKE $1 OR city ILIKE $1) AND bedrooms = $2
           ${priceClause} ORDER BY id DESC LIMIT 5`,
          params
        );
        if (rows.length === 1) {
          const ppData = await extractPrivatePropertyData(rows[0].listing_url);
          if (ppData?.address) {
            photoUrls = ppData.photoUrls || [];
            address = ppData.address;
            if (!askingPrice && ppData.askingPrice) askingPrice = ppData.askingPrice;
            input = rows[0].listing_url;
            ppResolved = true;
            log(1, `LOCAL DB MATCH (suburb+beds+price, unique): ${rows[0].listing_url}`);
          }
        } else if (rows.length > 1) {
          log(1, `${rows.length} candidates in DB for ${p24Suburb}/${p24Beds}bed — too ambiguous`);
        }
      }

      // Strategy 3: Vision API fallback (only if no local match found)
      if (!ppResolved && ogImage) {
        log(1, `No local match — trying Vision API reverse image search`);
        try {
          const { reverseImageSearch } = require('./match-p24-to-pp');
          const matchingPages = await reverseImageSearch(ogImage);
          const ppCandidates = [];
          for (const page of matchingPages.filter(u => u.includes('privateproperty.co.za/for-sale/'))) {
            const tMatch = page.match(/(https?:\/\/www\.privateproperty\.co\.za\/for-sale\/[^?#]+\/T\d+)/);
            if (tMatch && !ppCandidates.includes(tMatch[1])) ppCandidates.push(tMatch[1]);
          }

          for (const candidateUrl of ppCandidates) {
            const ppUrlParts = candidateUrl.replace(/.*\/for-sale\//, '').split('/');
            const ppSuburb = (ppUrlParts[3] || '').replace(/-/g, ' ').toLowerCase();
            const ppCity = (ppUrlParts[2] || '').replace(/-/g, ' ').toLowerCase();
            const suburbMatch = ppSuburb && p24Suburb && (ppSuburb.includes(p24Suburb.toLowerCase()) || p24Suburb.toLowerCase().includes(ppSuburb));
            const cityMatch = !p24City || !ppCity || ppCity.includes(p24City.toLowerCase()) || p24City.toLowerCase().includes(ppCity);

            if (suburbMatch && cityMatch) {
              const ppData = await extractPrivatePropertyData(candidateUrl);
              if (ppData?.address && (!p24Beds || !ppData.bedrooms || p24Beds === ppData.bedrooms)) {
                photoUrls = ppData.photoUrls || [];
                address = ppData.address;
                if (!askingPrice && ppData.askingPrice) askingPrice = ppData.askingPrice;
                input = candidateUrl;
                ppResolved = true;
                log(1, `VISION MATCH: ${candidateUrl} → ${photoUrls.length} photos, "${address}"`);
                break;
              }
            }
          }
        } catch (err) {
          log(1, `Vision match failed: ${err.message}`);
        }
      }

      // Fallback: no PP match — use Puppeteer to get P24 photos (customer is paying)
      if (!ppResolved) {
        address = ogTitle
          ? ogTitle.replace(/\s*[-–|]\s*Property24.*$/i, '').replace(/\s+for\s+sale\s+in\s+/i, ' in ').replace(/\s+in\s+in\s+/i, ' in ')
          : extractProperty24Data(html).address;

        log(1, `No PP match — scraping P24 photos with Puppeteer`);
        try {
          const puppeteer = require('puppeteer');
          const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
          const p24Page = await browser.newPage();
          await p24Page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
          await p24Page.goto(input, { waitUntil: 'networkidle0', timeout: 25000 });

          const p24Data = await p24Page.evaluate(() => {
            const r = { photos: [] };
            const seen = new Set();
            const pageHtml = document.documentElement.innerHTML;

            // Find all prop24 CDN image IDs
            const idMatches = pageHtml.match(/images\.prop24\.com\/(\d+)/g) || [];
            for (const m of idMatches) {
              const id = m.match(/(\d+)$/)?.[1];
              if (id && !seen.has(id) && parseInt(id) > 300000000) {
                seen.add(id);
                r.photos.push('https://images.prop24.com/' + id + '/Ensure1280x720');
              }
            }

            // Also check img/data-src elements
            document.querySelectorAll('img[src], img[data-src]').forEach(el => {
              const src = el.src || el.dataset?.src || '';
              if ((src.includes('property24') || src.includes('prop24') || src.includes('imgix')) && !src.includes('logo') && !src.includes('icon')) {
                const idMatch = src.match(/(\d{9,})/);
                if (idMatch && !seen.has(idMatch[1])) {
                  seen.add(idMatch[1]);
                  r.photos.push('https://images.prop24.com/' + idMatch[1] + '/Ensure1280x720');
                }
              }
            });

            // Price
            const allEls = document.querySelectorAll('*');
            for (const el of allEls) {
              const t = el.textContent?.trim() || '';
              if (/^R\s*[\d\s,]+$/.test(t)) {
                const p = parseInt(t.replace(/\\D/g, ''));
                if (p >= 100000 && p <= 500000000) { r.price = p; break; }
              }
            }

            // Beds/baths
            const body = document.body.innerText;
            const bedsM = body.match(/(\d+)\s*Bed/i);
            const bathsM = body.match(/(\d+)\s*Bath/i);
            r.bedrooms = bedsM ? parseInt(bedsM[1]) : null;
            r.bathrooms = bathsM ? parseInt(bathsM[1]) : null;

            // Street address
            try {
              document.querySelectorAll('script[type="application/ld+json"]').forEach(el => {
                const ld = JSON.parse(el.innerHTML);
                if (ld.address?.streetAddress) r.streetAddress = ld.address.streetAddress;
              });
            } catch {}

            // Description
            const descEl = document.querySelector('[class*="description"], [class*="listing-body"], [class*="property-description"]');
            r.description = descEl ? descEl.textContent.trim().substring(0, 3000) : null;

            return r;
          });

          await browser.close();

          photoUrls = p24Data.photos.length > 0 ? p24Data.photos : (ogImage ? [ogImage] : []);
          if (!askingPrice && p24Data.price) askingPrice = p24Data.price;
          if (p24Data.streetAddress) {
            address = `${p24Data.streetAddress}, ${address}`;
          }
          // Store description if we got one
          if (p24Data.description && p24Data.description.length > 20 && propertyId) {
            await pool.query('UPDATE properties SET description = COALESCE(NULLIF(description, $1), $2) WHERE id = $3 AND (description IS NULL OR LENGTH(description) < 10)', ['', p24Data.description, propertyId]).catch(() => {});
          }
          log(1, `P24 Puppeteer: ${photoUrls.length} photos, price: R${askingPrice || '?'}, desc: ${p24Data.description ? p24Data.description.length + ' chars' : 'none'}, address: "${address}"`);
        } catch (err) {
          log(1, `P24 Puppeteer failed: ${err.message} — using OG image only`);
          photoUrls = ogImage ? [ogImage] : [];
        }
      }

      } // close else { html } block

      if (!address) {
        throw new Error('Could not extract address from Property24 listing');
      }
      } // close if (!propertyId)
    } else if (isPrivatePropertyURL(input)) {
      log(1, `Fetching PrivateProperty listing: ${input}`);
      const extracted = await extractPrivatePropertyData(input);
      if (!extracted) throw new Error('Could not fetch PrivateProperty listing');
      photoUrls = extracted.photoUrls || [];
      address = extracted.address;
      if (!askingPrice && extracted.askingPrice) askingPrice = extracted.askingPrice;
      log(1, `Extracted ${photoUrls.length} photos, address: "${address}", price: R${askingPrice}`);
      if (!address) throw new Error('Could not extract address from PrivateProperty listing');
    } else {
      address = input;
      log(1, `Using address directly: "${address}"`);
    }

    // Geocode — pass listing URL for location context (prevents "Albany" → Albany NY)
    log(1, 'Geocoding address...');
    const geo = await maps.geocode(address, input);
    if (geo) {
      log(1, `Geocoded: ${geo.lat}, ${geo.lng} — ${geo.suburb}, ${geo.city}, ${geo.province}`);
    } else {
      log(1, 'Geocoding failed — continuing without coordinates');
    }

    // ── STEP 02: Deeds lookup (GVR free → DeedsWeb R18/query) ─────
    log(2, 'Deeds lookup');

    let deedsResult = null;
    try {
      deedsResult = await windeed.lookupAddress(address);
      if (deedsResult) {
        propertyId = deedsResult.property_id;
        log(2, `Deeds found: ERF ${deedsResult.erf_number}, owner: ${deedsResult.registered_owner}, municipal: R${deedsResult.municipal_value}`);
      } else {
        log(2, 'Deeds lookup returned no results — will try GVR enrichment after property creation');
      }
    } catch (err) {
      log(2, `Deeds lookup error (non-fatal): ${err.message}`);
    }

    // If Windeed didn't create the property, find existing or create new
    if (!propertyId && input.startsWith('http')) {
      // First: match by listing_url (clean URL for consistent matching)
      const cleanInput = input.replace(/[?#].*$/, '').replace(/\/+$/, '');
      const { rows: byUrl } = await pool.query(
        "SELECT id FROM properties WHERE listing_url ILIKE $1 OR listing_url ILIKE $2 ORDER BY id DESC LIMIT 1",
        [`%${cleanInput}%`, `%${cleanInput}/%`]
      );
      if (byUrl.length > 0) {
        propertyId = byUrl[0].id;
        log(2, `Found existing property ${propertyId} by listing URL`);
      }

      // Second: match by PP/P24 listing ID in erf_number
      if (!propertyId) {
        const ppMatch = input.match(/(T\d+)/);
        const p24Match = input.match(/\/(\d{6,})(?:\/|$)/);
        const erfLookup = ppMatch ? `PP_${ppMatch[1]}` : p24Match ? `P24_${p24Match[1]}` : null;
        if (erfLookup) {
          const { rows: byErf } = await pool.query('SELECT id FROM properties WHERE erf_number = $1', [erfLookup]);
          if (byErf.length > 0) {
            propertyId = byErf[0].id;
            log(2, `Found existing property ${propertyId} by listing ID ${erfLookup}`);
          }
        }
      }
    }

    if (!propertyId) {
      // Third: match by address text
      const { rows: existing } = await pool.query(
        `SELECT id FROM properties WHERE address_raw ILIKE $1 OR address_normalised ILIKE $1 OR street_address ILIKE $1 LIMIT 1`,
        [`%${address}%`]
      );
      if (existing.length > 0) {
        propertyId = existing[0].id;
        log(2, `Found existing property ${propertyId} matching "${address}"`);
      }
    }

    if (!propertyId) {
      const erfNumber = `UNVERIFIED_${Date.now()}`;
      const { rows } = await pool.query(
        `INSERT INTO properties (erf_number, address_raw, address_normalised, suburb, city, province, lat, lng)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (erf_number) DO UPDATE SET address_raw = EXCLUDED.address_raw
         RETURNING id`,
        [
          erfNumber,
          address,
          geo ? geo.formatted_address : null,
          geo ? geo.suburb : null,
          geo ? geo.city : null,
          geo ? geo.province : null,
          geo ? geo.lat : null,
          geo ? geo.lng : null,
        ]
      );
      propertyId = rows[0].id;
      log(2, `Created property ${propertyId} (ERF pending Windeed)`);
    } else if (geo) {
      // Update with geocode data
      await pool.query(
        `UPDATE properties SET lat = $1, lng = $2, address_normalised = COALESCE($3, address_normalised), suburb = COALESCE($4, suburb), city = COALESCE($5, city), province = COALESCE($6, province) WHERE id = $7`,
        [geo.lat, geo.lng, geo.formatted_address, geo.suburb, geo.city, geo.province, propertyId]
      );
    }

    // Record provenance for geocode + listing data
    const provenance = require('./provenance');
    if (geo) {
      const mapsUrl = `https://www.google.com/maps/@${geo.lat},${geo.lng},18z`;
      await provenance.recordSource(propertyId, 'Google Maps Geocoding API', mapsUrl, 'verified',
        ['lat', 'lng', 'address_normalised', 'suburb', 'city', 'province']);
    }
    if (input.startsWith('http')) {
      const listingSource = isProperty24URL(input) ? 'Property24 Listing' : isPrivatePropertyURL(input) ? 'PrivateProperty Listing' : 'Listing URL';
      const listingFields = ['address_raw', 'listing_url'];
      if (askingPrice) listingFields.push('asking_price');
      await provenance.recordSource(propertyId, listingSource, input, 'scraped', listingFields);
    }

    // ── STEP 02B: GVR enrichment (free municipal data) ────────────
    // If deeds lookup didn't return municipal_value or owner, try GVR
    if (propertyId && !deedsResult) {
      log('2B', 'Enriching from GVR (free municipal valuation data)');
      try {
        const { rows: propCheck } = await pool.query(
          'SELECT municipal_valuation, owner_name_gvr, suburb, city FROM properties WHERE id = $1',
          [propertyId]
        );
        const prop = propCheck[0];
        // If we have suburb+city, try to match GVR data from existing properties in the same area
        if (prop && !prop.municipal_valuation && prop.suburb) {
          const { rows: gvrMatch } = await pool.query(
            `SELECT municipal_valuation, owner_name_gvr, stand_size_sqm, zoning, property_category
             FROM properties
             WHERE suburb ILIKE $1 AND municipal_valuation IS NOT NULL AND gvr_source IS NOT NULL
             AND address_raw ILIKE $2
             ORDER BY gvr_fetched_at DESC LIMIT 1`,
            [`%${prop.suburb}%`, `%${address.split(',')[0]}%`]
          );
          if (gvrMatch.length > 0) {
            const g = gvrMatch[0];
            await pool.query(
              `UPDATE properties SET
                 municipal_valuation = COALESCE(municipal_valuation, $1),
                 owner_name_gvr = COALESCE(owner_name_gvr, $2),
                 stand_size_sqm = COALESCE(stand_size_sqm, $3),
                 zoning = COALESCE(zoning, $4),
                 property_category = COALESCE(property_category, $5)
               WHERE id = $6`,
              [g.municipal_valuation, g.owner_name_gvr, g.stand_size_sqm, g.zoning, g.property_category, propertyId]
            );
            log('2B', `GVR match: municipal R${g.municipal_valuation}, owner: ${g.owner_name_gvr || 'n/a'}`);
          } else {
            log('2B', 'No GVR match found for this address');
          }
        } else if (prop && prop.municipal_valuation) {
          log('2B', `Already has municipal value R${prop.municipal_valuation} — skipping GVR`);
        }
      } catch (err) {
        log('2B', `GVR enrichment error (non-fatal): ${err.message}`);
      }
    }

    // ── STEP 03: Resale check ───────────────────────────────────────
    log(3, 'Checking for recent existing report (resale)');

    const { rows: recentReports } = await pool.query(
      `SELECT id, pdf_url, decision, decision_reasoning
       FROM property_reports
       WHERE property_id = $1 AND status = 'complete'
         AND created_at > NOW() - INTERVAL '90 days'
       ORDER BY created_at DESC LIMIT 1`,
      [propertyId]
    );

    if (recentReports.length > 0) {
      const existing = recentReports[0];
      log(3, `Recent report found: ID ${existing.id} (reusing collected data, regenerating PDF with latest format)`);

      // Track resale
      await pool.query(
        'UPDATE property_reports SET times_sold = times_sold + 1 WHERE id = $1',
        [existing.id]
      );

      // Don't skip — fall through to regenerate the PDF with latest data and formatting
      // But the pipeline steps will skip anything already collected (photos, vision, crime, etc.)
      // This gives us an updated PDF without re-running expensive collection steps
    } else {
      log(3, 'No recent report — generating fresh report');
    }

    // ── STEP 03B: Store extracted listing data on property ──────────
    log('3B', 'Storing listing data on property');
    {
      const updates = [];
      const values = [];
      let idx = 1;
      const add = (field, val) => { if (val != null) { updates.push(`${field} = COALESCE($${idx}, ${field})`); values.push(val); idx++; } };

      add('listing_url', input.startsWith('http') ? input : null);
      add('asking_price', askingPrice || null);

      // PP extraction provides richer data
      if (isPrivatePropertyURL(input)) {
        try {
          const html = await fetchHTML(input);
          const bodyText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
          const bedsMatch = bodyText.match(/(\d+)\s*Bed/i);
          const bathsMatch = bodyText.match(/(\d+)\s*Bath/i);
          const areaMatch = bodyText.match(/(\d+)\s*m²/);
          const descMatch = html.match(/<[^>]*class="[^"]*(?:description|listing-body)[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i);
          add('bedrooms', bedsMatch ? parseInt(bedsMatch[1]) : null);
          add('bathrooms', bathsMatch ? parseInt(bathsMatch[1]) : null);
          add('floor_area_sqm', areaMatch ? parseInt(areaMatch[1]) : null);
          add('description', descMatch ? descMatch[1].replace(/<[^>]+>/g, '').trim().substring(0, 2000) : null);
        } catch (e) { log('3B', `PP detail extraction error (non-fatal): ${e.message}`); }
      } else if (isProperty24URL(input)) {
        // Skip re-fetching P24 if property already has beds/baths (set by tease)
        const { rows: existCheck } = await pool.query('SELECT bedrooms, bathrooms, description FROM properties WHERE id = $1', [propertyId]);
        if (existCheck[0]?.bedrooms && existCheck[0]?.description) {
          log('3B', 'P24 data already stored by tease — skipping re-fetch');
        } else {
        try {
          const html = await fetchHTML(input);
          const bodyText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
          const bedsMatch = bodyText.match(/(\d+)\s*Bed/i);
          const bathsMatch = bodyText.match(/(\d+)\s*Bath/i);
          const areaMatch = bodyText.match(/(\d+)\s*m²/);
          const descMatch = html.match(/<[^>]*class="[^"]*(?:description|listing-body|p24_regularListing)[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i);
          add('bedrooms', bedsMatch ? parseInt(bedsMatch[1]) : null);
          add('bathrooms', bathsMatch ? parseInt(bathsMatch[1]) : null);
          add('floor_area_sqm', areaMatch ? parseInt(areaMatch[1]) : null);
          add('description', descMatch ? descMatch[1].replace(/<[^>]+>/g, '').trim().substring(0, 2000) : null);
        } catch (e) { log('3B', `P24 detail extraction error (non-fatal): ${e.message}`); }
        } // close else (skip re-fetch)
      }

      // Extract suburb from listing URL if geocoder didn't provide one
      if (input.startsWith('http')) {
        const { rows: subCheck } = await pool.query('SELECT suburb FROM properties WHERE id = $1', [propertyId]);
        if (!subCheck[0]?.suburb) {
          // PP URL format: /for-sale/province/area/town/suburb/street/id
          const ppParts = input.replace(/.*\/for-sale\//, '').split('/');
          if (ppParts.length >= 5) {
            const urlSuburb = ppParts[3].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
            const urlCity = ppParts[2].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
            add('suburb', urlSuburb);
            add('city', urlCity);
            log('3B', `Suburb from listing URL: ${urlSuburb}, ${urlCity}`);
          }
          // P24 URL format: /for-sale/suburb/city/province/code/id
          const p24Parts = input.match(/property24\.com\/for-sale\/([^/]+)\/([^/]+)\/([^/]+)/);
          if (p24Parts) {
            const urlSuburb = p24Parts[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
            const urlCity = p24Parts[2].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
            add('suburb', urlSuburb);
            add('city', urlCity);
            log('3B', `Suburb from listing URL: ${urlSuburb}, ${urlCity}`);
          }
        }
      }

      if (updates.length > 0) {
        values.push(propertyId);
        await pool.query(`UPDATE properties SET ${updates.join(', ')} WHERE id = $${idx}`, values);
        log('3B', `Stored ${updates.length} listing fields on property ${propertyId}`);

        // Record provenance for listing-extracted fields
        const listingFields = updates.map(u => u.split(' ')[0]); // extract field names
        const listingSource = isPrivatePropertyURL(input) ? 'PrivateProperty Listing' : isProperty24URL(input) ? 'Property24 Listing' : 'Listing';
        await provenance.recordSource(propertyId, listingSource, input, 'scraped', listingFields);
      }
    }

    // ── STEP 04: Image collection ───────────────────────────────────
    log(4, 'Collecting images');

    const fs = require('fs');
    const path = require('path');
    const imgDir = path.resolve(__dirname, 'dashboard', 'public', 'property-images');
    if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });

    function saveImageFile(base64Data, propId, type, ext) {
      const filename = `${propId}-${type}-${Date.now()}.${ext}`;
      const filePath = path.join(imgDir, filename);
      fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
      return `/property-images/${filename}`;
    }

    // Store listing photos — skip entirely if property already has photos
    const { rows: existingPhotoCheck } = await pool.query(
      "SELECT COUNT(*) AS c FROM property_images WHERE property_id = $1 AND source IN ('property24', 'privateproperty')",
      [propertyId]
    );
    const existingPhotoCount = parseInt(existingPhotoCheck[0].c);

    if (existingPhotoCount > 0) {
      log(4, `Already have ${existingPhotoCount} listing photos — keeping existing set`);
    } else if (photoUrls.length > 0) {
      const validPhotos = photoUrls.filter(url => {
        const lower = url.toLowerCase();
        if (lower.includes('.gif') || lower.includes('.svg')) return false;
        if (lower.includes('noimage') || lower.includes('blank') || lower.includes('loading')) return false;
        if (lower.includes('/icons/') || lower.includes('icon.')) return false;
        if (lower.includes('/for-sale/') && !lower.includes('images.')) return false;
        return true;
      });
      let added = 0;
      for (const url of validPhotos) {
        const { rowCount } = await pool.query(
          `INSERT INTO property_images (property_id, source, image_url, image_type)
           VALUES ($1, $2, $3, 'listing') ON CONFLICT (property_id, image_url) DO NOTHING`,
          [propertyId, isProperty24URL(input) ? 'property24' : 'privateproperty', url]
        );
        if (rowCount > 0) added++;
      }
      log(4, added > 0 ? `${added} new photos added (${validPhotos.length - added} already existed)` : `All ${validPhotos.length} photos already in DB`);
    }

    // Street View — skip if already exists
    let streetviewBase64 = null;
    let satelliteBase64 = null;

    const { rows: existingSV } = await pool.query(
      "SELECT COUNT(*) AS c FROM property_images WHERE property_id = $1 AND source = 'streetview'", [propertyId]
    );
    const { rows: existingSat } = await pool.query(
      "SELECT COUNT(*) AS c FROM property_images WHERE property_id = $1 AND source = 'satellite'", [propertyId]
    );

    if (geo) {
      if (parseInt(existingSV[0].c) > 0) {
        log(4, 'Street View already exists — skipping');
      } else {
        log(4, 'Fetching Street View image...');
        streetviewBase64 = await maps.getStreetView(geo.lat, geo.lng);
        if (streetviewBase64) {
          const localUrl = saveImageFile(streetviewBase64, propertyId, 'streetview', 'jpg');
          await pool.query(
            `INSERT INTO property_images (property_id, source, image_url, image_type)
             VALUES ($1, 'streetview', $2, 'streetview') ON CONFLICT (property_id, image_url) DO UPDATE SET source = EXCLUDED.source, image_type = 'streetview'`,
            [propertyId, localUrl]
          );
          log(4, `Street View saved: ${localUrl}`);
        }
      }

      if (parseInt(existingSat[0].c) > 0) {
        log(4, 'Satellite already exists — skipping');
      } else {
        log(4, 'Fetching satellite image...');
        satelliteBase64 = await maps.getSatelliteView(geo.lat, geo.lng);
        if (satelliteBase64) {
          const localUrl = saveImageFile(satelliteBase64, propertyId, 'satellite', 'png');
          await pool.query(
            `INSERT INTO property_images (property_id, source, image_url, image_type)
             VALUES ($1, 'satellite', $2, 'satellite') ON CONFLICT (property_id, image_url) DO UPDATE SET source = EXCLUDED.source, image_type = 'satellite'`,
            [propertyId, localUrl]
          );
          log(4, `Satellite saved: ${localUrl}`);
        }
      }
    } else {
      log(4, 'No coordinates — skipping Street View and satellite');
    }

    // ── STEP 05: Vision analysis — listing photos ───────────────────
    log(5, 'Vision analysis — listing photos');

    // Only analyse photos that don't have vision_analysis yet — filter out junk (placeholders, icons, GIFs, SVGs)
    const { rows: unanalysedPhotos } = await pool.query(
      `SELECT image_url FROM property_images WHERE property_id = $1 AND source IN ('property24', 'privateproperty') AND vision_analysis IS NULL AND image_url LIKE 'http%'
       AND image_url NOT LIKE '%.gif%' AND image_url NOT LIKE '%.svg%'
       AND image_url NOT LIKE '%NoImage%' AND image_url NOT LIKE '%blank%'
       AND image_url NOT LIKE '%loading%' AND image_url NOT LIKE '%icon%'
       AND image_url NOT LIKE '%/for-sale/%'`,
      [propertyId]
    );
    if (unanalysedPhotos.length > 0) {
      const urlsToAnalyse = unanalysedPhotos.map(r => r.image_url);
      log(5, `${urlsToAnalyse.length} unanalysed listing photos (skipping ${photoUrls.length - urlsToAnalyse.length} already done)`);
      try {
        const listingVision = await vision.analyseWithHFPrestage(propertyId, urlsToAnalyse);
        if (listingVision) {
          log(5, `Analysed ${listingVision.analyses.length} listing photos, ${listingVision.aggregated.vision_findings.length} total findings`);
        } else {
          log(5, 'No listing photos analysed (download failures)');
        }
      } catch (visionErr) {
        log(5, `Vision analysis error (non-fatal): ${visionErr.message}`);
      }
    } else {
      log(5, 'All listing photos already analysed — skipping');
    }

    // ── STEP 06: Vision analysis — Street View ──────────────────────
    log(6, 'Vision analysis — Street View');

    // Check if streetview already has vision_analysis
    const { rows: svCheck } = await pool.query(
      "SELECT id, vision_analysis FROM property_images WHERE property_id = $1 AND source = 'streetview' ORDER BY id DESC LIMIT 1",
      [propertyId]
    );
    if (svCheck.length > 0 && svCheck[0].vision_analysis) {
      log(6, 'Street View already analysed — skipping');
    } else if (streetviewBase64) {
      const svAnalysis = await vision.analyseStreetView(streetviewBase64);
      await pool.query(
        `UPDATE property_images SET vision_analysis = $1, analysed_at = NOW()
         WHERE id = (SELECT id FROM property_images WHERE property_id = $2 AND source = 'streetview' ORDER BY id DESC LIMIT 1)`,
        [JSON.stringify(svAnalysis), propertyId]
      );
      log(6, `Street View analysis: ${(svAnalysis.findings || []).length} findings`);
    } else if (svCheck.length > 0 && svCheck[0].image_url?.startsWith('/property-images/')) {
      // Streetview image exists but wasn't fetched this run — load from file and analyse
      const svPath = path.resolve(__dirname, 'dashboard', 'public', svCheck[0].image_url.replace(/^\//, ''));
      if (fs.existsSync(svPath) && fs.statSync(svPath).isFile()) {
        streetviewBase64 = fs.readFileSync(svPath).toString('base64');
        const svAnalysis = await vision.analyseStreetView(streetviewBase64);
        await pool.query('UPDATE property_images SET vision_analysis = $1, analysed_at = NOW() WHERE id = $2',
          [JSON.stringify(svAnalysis), svCheck[0].id]);
        log(6, `Street View analysis (from existing image): ${(svAnalysis.findings || []).length} findings`);
      } else {
        log(6, 'Street View image file not found — skipping');
      }
    } else {
      log(6, 'No Street View image — skipping');
    }

    // ── STEP 07: Vision analysis — satellite ────────────────────────
    log(7, 'Vision analysis — satellite');

    const { rows: satCheck } = await pool.query(
      "SELECT id, vision_analysis FROM property_images WHERE property_id = $1 AND source = 'satellite' ORDER BY id DESC LIMIT 1",
      [propertyId]
    );
    if (satCheck.length > 0 && satCheck[0].vision_analysis) {
      log(7, 'Satellite already analysed — skipping');
    } else if (satelliteBase64) {
      const satAnalysis = await vision.analyseSatellite(satelliteBase64);
      await pool.query(
        `UPDATE property_images SET vision_analysis = $1, analysed_at = NOW()
         WHERE id = (SELECT id FROM property_images WHERE property_id = $2 AND source = 'satellite' ORDER BY id DESC LIMIT 1)`,
        [JSON.stringify(satAnalysis), propertyId]
      );
      log(7, `Satellite analysis: roof=${satAnalysis.roof_material}, solar=${satAnalysis.solar_installed}, orientation=${satAnalysis.roof_orientation_estimate}`);
    } else if (satCheck.length > 0 && satCheck[0].image_url?.startsWith('/property-images/')) {
      const satPath = path.resolve(__dirname, 'dashboard', 'public', satCheck[0].image_url.replace(/^\//, ''));
      if (fs.existsSync(satPath) && fs.statSync(satPath).isFile()) {
        satelliteBase64 = fs.readFileSync(satPath).toString('base64');
        const satAnalysis = await vision.analyseSatellite(satelliteBase64);
        await pool.query('UPDATE property_images SET vision_analysis = $1, analysed_at = NOW() WHERE id = $2',
          [JSON.stringify(satAnalysis), satCheck[0].id]);
        log(7, `Satellite analysis (from existing image): roof=${satAnalysis.roof_material}, solar=${satAnalysis.solar_installed}, orientation=${satAnalysis.roof_orientation_estimate}`);
      } else {
        log(7, 'Satellite image file not found — skipping');
      }
    } else {
      log(7, 'No satellite image — skipping');
    }

    // ── STEP 05B: Deep specialist analysis routing ──────────────────
    log('5B', 'Deep specialist analysis routing');
    {
      const counts = { db_board: 0, ceiling: 0, exterior: 0, plumbing: 0 };
      try {
        // Only process images that have base vision_analysis but NOT specialist_findings yet
        const { rows: analysedImgs } = await pool.query(
          `SELECT id, image_url, vision_analysis FROM property_images
           WHERE property_id = $1 AND vision_analysis IS NOT NULL
             AND image_url LIKE 'http%'
             AND (vision_analysis->>'specialist_findings') IS NULL
           ORDER BY id`, [propertyId]
        );

        if (analysedImgs.length === 0) {
          log('5B', 'All images already have specialist analysis — skipping');
        }

        for (const img of analysedImgs) {
          if (counts.db_board >= 3 && counts.ceiling >= 3 && counts.exterior >= 3 && counts.plumbing >= 3) break;
          const va = typeof img.vision_analysis === 'string' ? JSON.parse(img.vision_analysis) : img.vision_analysis;
          const photoType = va?.photo_type;
          const findingsText = JSON.stringify(va?.findings || []).toLowerCase();

          try {
            if (photoType === 'db_board' && counts.db_board < 3) {
              const buffer = await vision.downloadImage(img.image_url);
              const result = await vision.analyseDBBoard(buffer.toString('base64'));
              await pool.query('UPDATE property_images SET vision_analysis = vision_analysis || $1::jsonb WHERE id = $2',
                [JSON.stringify({ db_board: result.db_board, specialist_findings: result.findings }), img.id]);
              counts.db_board++;
            }

            if ((photoType === 'ceiling' || (va?.findings || []).some(f => f.category === 'ceiling' && (f.severity === 'CRITICAL' || f.severity === 'HIGH'))) && counts.ceiling < 3) {
              const buffer = await vision.downloadImage(img.image_url);
              const result = await vision.analyseCeilingDeep(buffer.toString('base64'));
              await pool.query('UPDATE property_images SET vision_analysis = vision_analysis || $1::jsonb WHERE id = $2',
                [JSON.stringify({ ceiling: result.ceiling, specialist_findings: result.findings }), img.id]);
              counts.ceiling++;
            }

            if (photoType === 'exterior' && counts.exterior < 3) {
              const buffer = await vision.downloadImage(img.image_url);
              const result = await vision.analyseExteriorSecurity(buffer.toString('base64'));
              await pool.query('UPDATE property_images SET vision_analysis = vision_analysis || $1::jsonb WHERE id = $2',
                [JSON.stringify({ security_assessment: result.security_assessment, specialist_findings: result.findings }), img.id]);
              counts.exterior++;
            }

            if (['bathroom', 'kitchen', 'other'].includes(photoType) &&
                (findingsText.includes('pipe') || findingsText.includes('geyser') || findingsText.includes('plumbing') ||
                 findingsText.includes('rust') || findingsText.includes('corrosion') || findingsText.includes('tap') || findingsText.includes('basin')) &&
                counts.plumbing < 3) {
              const buffer = await vision.downloadImage(img.image_url);
              const result = await vision.analysePlumbing(buffer.toString('base64'));
              await pool.query('UPDATE property_images SET vision_analysis = vision_analysis || $1::jsonb WHERE id = $2',
                [JSON.stringify({ plumbing: result.plumbing, specialist_findings: result.findings }), img.id]);
              counts.plumbing++;
            }
          } catch (specialistErr) {
            console.error(`[step 05b] Specialist error on image ${img.id}: ${specialistErr.message}`);
          }
        }
      } catch (err) {
        console.error(`[step 05b] Error: ${err.message}`);
      }
      const total = counts.db_board + counts.ceiling + counts.exterior + counts.plumbing;
      log('5B', `${total} photos sent for specialist deep analysis: db_board=${counts.db_board}, ceiling=${counts.ceiling}, exterior=${counts.exterior}, plumbing=${counts.plumbing}`);
    }

    // ── STEP 06B: Temporal change detection ──────────────────────────
    if (streetviewBase64 && geo) {
      log('6B', 'Temporal change detection — comparing current vs historical Street View');
      try {
        const historicalBase64 = maps.getStreetViewHistorical ? await maps.getStreetViewHistorical(geo.lat, geo.lng) : null;
        if (historicalBase64) {
          const temporalResult = await vision.analyseTemporalChange(streetviewBase64, historicalBase64);
          await pool.query(
            `UPDATE property_reports SET temporal_change_analysis = $1 WHERE property_id = $2 AND status != 'failed' ORDER BY created_at DESC LIMIT 1`,
            [JSON.stringify(temporalResult), propertyId]
          ).catch(() => {});
          log('6B', `Temporal analysis: trajectory=${temporalResult.condition_trajectory}, ${(temporalResult.red_flags || []).length} red flags`);
        } else {
          log('6B', 'No historical Street View available — skipping');
        }
      } catch (err) {
        log('6B', `Temporal analysis error (non-fatal): ${err.message}`);
      }
    }

    // ── STEP 08: Risk data collection ─────────────────────────────────
    log(8, 'Collecting risk data (water, solar, compliance)');

    // Fetch CURRENT property state (after step 3B stored listing data + geocode + suburb from URL)
    const { rows: propState } = await pool.query(
      'SELECT water_quality_score, solar_ghi_kwh_year, electrical_coc_required, city, province, suburb, lat, lng FROM properties WHERE id=$1',
      [propertyId]
    );
    const ps = propState[0] || {};
    const areaSuburb = ps.suburb || '';
    const areaCity = ps.city || '';

    try {
      // Water quality — skip if already collected
      if (ps.water_quality_score != null) {
        log(8, `Water already collected (${ps.water_quality_score}/10) — skipping`);
      } else {
        const collectMunicipal = require('./collect-municipal');
        const waterResult = await collectMunicipal.collectForProperty(propertyId);
        if (waterResult?.water_quality_score != null) {
          log(8, `Water: ${waterResult.water_quality_score}/10, Sewerage: ${waterResult.sewerage_quality_score}/10`);
        } else {
          log(8, 'No Blue/Green Drop data for this municipality');
        }
      }

      // Solar data — skip if already collected
      if (ps.solar_ghi_kwh_year != null) {
        log(8, `Solar already collected (GHI=${ps.solar_ghi_kwh_year}) — skipping`);
      } else if (geo) {
        const collectSolar = require('./collect-solar');
        const solar = await collectSolar.getSolarData(propertyId);
        if (solar) {
          log(8, `Solar: GHI=${solar.ghi_kwh_m2_year} kWh/m²/year, PV=${solar.pv_output_kwh_year} kWh/year`);
        }
      }

      // Compliance certificates — skip if already set
      if (ps.electrical_coc_required) {
        log(8, 'Compliance already applied — skipping');
      } else {
        await pool.query('UPDATE properties SET electrical_coc_required=TRUE WHERE id=$1', [propertyId]);
        if (ps.city === 'Cape Town') await pool.query('UPDATE properties SET plumbing_coc_required=TRUE WHERE id=$1', [propertyId]);
        if (['Western Cape', 'KwaZulu-Natal'].includes(ps.province)) await pool.query('UPDATE properties SET beetle_cert_required=TRUE WHERE id=$1', [propertyId]);
        log(8, 'Compliance rules applied');
      }
    } catch (err) {
      log(8, `Risk data error (non-fatal): ${err.message}`);
    }

    // ── STEP 08B: Crime data ────────────────────────────────────────
    log('8B', 'Collecting crime statistics');

    if (!areaSuburb) {
      log('8B', 'No suburb set — skipping crime data (suburb is required for accurate crime stats)');
    } else {
      // Skip if crime_detailed already exists for this area
      const { rows: existingCrime } = await pool.query(
        "SELECT COUNT(*) AS c FROM area_risk_data WHERE risk_type = 'crime_detailed' AND (suburb ILIKE $1 OR city ILIKE $1) AND city ILIKE $2",
        [areaSuburb, areaCity]
      );
      if (parseInt(existingCrime[0].c) > 0) {
        log('8B', `Crime data already collected for ${areaSuburb} — skipping`);
        // Ensure crime score is propagated to this property
        try {
          const { rows: crimeScore } = await pool.query("SELECT suburb_crime_score FROM properties WHERE id = $1", [propertyId]);
          if (!crimeScore[0]?.suburb_crime_score) {
            const { rows: cd } = await pool.query("SELECT details FROM area_risk_data WHERE risk_type = 'crime_detailed' AND (suburb ILIKE $1 OR city ILIKE $1) AND city ILIKE $2 LIMIT 1", [areaSuburb, areaCity]);
            if (cd[0]?.details?.total_latest) {
              const score = Math.min(10, Math.round(cd[0].details.total_latest / 500));
              await pool.query("UPDATE properties SET suburb_crime_score = $1 WHERE id = $2", [score, propertyId]);
              log('8B', `Propagated crime score: ${score}/10`);
            }
          }
        } catch {}
      } else {
        try {
          const collectCrime = require('./collect-crime');
          const crimeResult = await collectCrime.collectForProperty(propertyId);
          if (crimeResult?.total) {
            log('8B', `Crime: ${crimeResult.station} — ${crimeResult.total} incidents (${crimeResult.year})`);
          } else {
            log('8B', 'No crime data returned');
          }
        } catch (err) {
          log('8B', `Crime data error (non-fatal): ${err.message}`);
        }
      }
    }

    // ── STEP 09: Feature extraction from description ────────────────
    log(9, 'Extracting features from listing description');

    {
      const { rows: featCheck } = await pool.query('SELECT description, extracted_features FROM properties WHERE id=$1', [propertyId]);
      if (featCheck[0]?.extracted_features) {
        log(9, 'Features already extracted — skipping');
      } else if (featCheck[0]?.description && featCheck[0].description.length > 10) {
        try {
          const extractor = require('./extract-features');
          const extResult = await extractor.processProperty(propertyId);
          log(9, `Extracted ${extResult.fields_updated} fields: ${(extResult.fields || []).join(', ')}`);
        } catch (err) {
          log(9, `Feature extraction error (non-fatal): ${err.message}`);
        }
      } else {
        log(9, 'No description available — skipping');
      }
    }

    // ── STEP 09B: Neighbourhood Pros and Cons ──────────────────────────────────
    log('9B', 'Neighbourhood Pros and Cons — scanning nearby reviews');

    // Skip if social_concerns already exists for this area
    const { rows: existingSocial } = await pool.query(
      "SELECT COUNT(*) AS c FROM area_risk_data WHERE risk_type = 'social_concerns' AND (suburb ILIKE $1 OR city ILIKE $1) AND city ILIKE $2",
      [areaSuburb, areaCity]
    );
    if (parseInt(existingSocial[0].c) > 0) {
      log('9B', `Neighbourhood Pros and Cons already done for ${areaSuburb} — skipping`);
    } else if (geo || (ps.lat && ps.lng)) {
      try {
        const collectSocial = require('./collect-social');
        const socialResult = await collectSocial.collectForProperty(propertyId);
        if (socialResult) {
          log('9B', `Scanned ${socialResult.places_scanned} places, ${socialResult.concerns.length} concerns found`);
        }
      } catch (err) {
        log('9B', `Neighbourhood Pros and Cons error (non-fatal): ${err.message}`);
      }
    } else {
      log('9B', 'No coordinates — skipping social listening');
    }

    // ── STEP 09C: Security & Community Intelligence ─────────────────
    log('9C', 'Security & Community — security companies, CPF, neighbourhood watch');

    const { rows: existingSecurity } = await pool.query(
      "SELECT COUNT(*) AS c FROM area_risk_data WHERE risk_type = 'security_community' AND (suburb ILIKE $1 OR city ILIKE $1) AND city ILIKE $2",
      [areaSuburb, areaCity]
    );
    if (parseInt(existingSecurity[0].c) > 0) {
      log('9C', `Security & Community already done for ${areaSuburb} — skipping`);
    } else if (geo || (ps.lat && ps.lng)) {
      try {
        const collectSecurity = require('./collect-security');
        const secResult = await collectSecurity.collectForProperty(propertyId);
        if (secResult) {
          log('9C', `Found ${secResult.security_companies_count} security companies, CPF: ${secResult.cpf_found ? 'yes' : 'no'}, NHW: ${secResult.nhw_found ? 'yes' : 'no'}, sentiment: ${secResult.sentiment_overall}`);
        }
      } catch (err) {
        log('9C', `Security & Community error (non-fatal): ${err.message}`);
      }
    } else {
      log('9C', 'No coordinates — skipping security & community');
    }

    // ── STEP 10: Building age risk matrix ───────────────────────────
    log(10, 'Building age risk matrix');

    const { rows: propRows } = await pool.query(
      'SELECT construction_era FROM properties WHERE id = $1',
      [propertyId]
    );
    const era = propRows[0]?.construction_era;
    log(10, `Construction era: ${era || 'unknown'} → age risk matrix applied`);

    // ── STEP 10B: Buyer Risk Index calculation ──────────────────────
    log('10B', 'Calculating BuyerRiskIndex from verified data');

    let buyerRiskIndex = 5; // default
    try {
      // Fetch latest aggregated data from property_images
      const { rows: imgRows } = await pool.query(
        `SELECT vision_analysis FROM property_images WHERE property_id = $1 AND vision_analysis IS NOT NULL`,
        [propertyId]
      );
      const allAnalyses = imgRows.map(r => typeof r.vision_analysis === 'string' ? JSON.parse(r.vision_analysis) : r.vision_analysis);
      const agg = vision.aggregateFindings(allAnalyses);

      const asbestosMap = { NEGLIGIBLE: 0, LOW: 1, MEDIUM: 3, HIGH: 7, CRITICAL: 10 };
      const asbestosScore = asbestosMap[agg.asbestos_risk] || 0;
      const structuralCount = (agg.structural_flags || []).filter(f => f.severity === 'CRITICAL' || f.severity === 'HIGH').length;
      const complianceCount = (agg.compliance_flags || []).filter(f => f.severity === 'CRITICAL' || f.severity === 'HIGH').length;
      const eraMap = { 'pre-1977': 3, '1977-1990': 2, '1990-2000': 1 };
      const eraRisk = era ? (eraMap[era] || 0) : 0;

      buyerRiskIndex = Math.min(10, Math.round(
        (agg.insurance_risk_score * 0.25) +
        (asbestosScore * 0.20) +
        ((10 - (agg.security_score || 5)) * 0.15) +
        (Math.min(10, structuralCount * 1.5) * 0.20) +
        (Math.min(10, complianceCount * 1.5) * 0.10) +
        (eraRisk * 0.10)
      ));
      log('10B', `BuyerRiskIndex: ${buyerRiskIndex}/10 (insurance=${agg.insurance_risk_score}, asbestos=${asbestosScore}, security=${agg.security_score || 'n/a'}, structural=${structuralCount}, compliance=${complianceCount}, era=${eraRisk})`);
    } catch (err) {
      log('10B', `BuyerRiskIndex calculation error (non-fatal): ${err.message}`);
    }

    // ── STEP 11: B2B field propagation from vision data ────────────
    log(11, 'B2B field propagation from vision data');

    try {
      const { rows: imgRows2 } = await pool.query(
        'SELECT vision_analysis FROM property_images WHERE property_id = $1 AND vision_analysis IS NOT NULL',
        [propertyId]
      );
      const allVA = imgRows2.map(r => typeof r.vision_analysis === 'string' ? JSON.parse(r.vision_analysis) : r.vision_analysis);
      const agg = vision.aggregateFindings(allVA);

      await pool.query(
        `UPDATE properties SET
          roof_material = COALESCE($1, roof_material),
          solar_installed = COALESCE($2, solar_installed),
          roof_orientation = COALESCE($3, roof_orientation),
          security_visible = COALESCE($4, security_visible)
        WHERE id = $5`,
        [
          agg.roof_material !== 'unknown' ? agg.roof_material : null,
          agg.solar_installed || null,
          agg.roof_orientation !== 'unclear' ? agg.roof_orientation : null,
          agg.security_visible || null,
          propertyId,
        ]
      );
      log(11, `Properties table updated: roof=${agg.roof_material}, solar=${agg.solar_installed}, orientation=${agg.roof_orientation}`);
    } catch (err) {
      log(11, `B2B propagation error (non-fatal): ${err.message}`);
    }

    // ── STEP 11B: Collect area data for report sections ──────────────
    // These fill the sold prices, market trends, electricity, fibre, climate, schools sections
    log('11B', 'Collecting area data (sold prices, trends, electricity, fibre, climate, schools, costs)');
    const collectors = [
      { name: 'schools', mod: './collect-schools' },
      { name: 'climate', mod: './collect-climate' },
      { name: 'soldprices', mod: './collect-sold-prices' },
      { name: 'electricity', mod: './collect-electricity' },
      { name: 'fibre', mod: './collect-fibre' },
      { name: 'pricetrends', mod: './collect-price-trends' },
      { name: 'propertycosts', mod: './collect-property-costs' },
    ];
    for (const c of collectors) {
      try {
        const mod = require(c.mod);
        const fn = mod.collectForProperty || mod.default?.collectForProperty;
        if (fn) {
          await Promise.race([
            fn(propertyId),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 30000)),
          ]);
          log('11B', `${c.name}: done`);
        }
      } catch (err) {
        log('11B', `${c.name}: ${err.message} (non-fatal)`);
      }
    }

    // ── STEP 12: Create report record ─────────────────────────────
    log(12, 'Creating report record (PDF exported on-demand from property page)');

    const { rows: reportRows } = await pool.query(
      `INSERT INTO property_reports (property_id, asking_price, decision, decision_reasoning, status, buyer_risk_index)
       VALUES ($1, $2, 'NEGOTIATE', 'Data-driven report — review findings and negotiate accordingly', 'complete', $3)
       RETURNING id`,
      [propertyId, askingPrice || 0, buyerRiskIndex]
    );
    reportId = reportRows[0].id;
    log(12, `Report ${reportId} created for property ${propertyId}`);

    // ── STEP 14: Create order record ────────────────────────────────
    log(14, 'Creating order record');

    let liveSettings = { report_price: 169, payment_enabled: false };
    try { liveSettings = JSON.parse(require('fs').readFileSync('/tmp/surepath-settings.json', 'utf8')); } catch {}
    const paymentEnabled = !!(process.env.PAYFAST_MERCHANT_ID && process.env.PAYFAST_MERCHANT_KEY && liveSettings.payment_enabled);
    const reportPrice = paymentEnabled ? (liveSettings.report_price || 169) : 0;
    const paymentStatus = paymentEnabled ? 'pending' : 'free';

    await pool.query(
      `INSERT INTO orders (property_id, report_id, phone_number, price_zar, was_resale, payment_status)
       VALUES ($1, $2, $3, $4, FALSE, $5)`,
      [propertyId, reportId, phoneNumber, reportPrice, paymentStatus]
    );

    await pool.query(
      'UPDATE property_reports SET times_sold = times_sold + 1 WHERE id = $1',
      [reportId]
    );

    log(14, 'Order created');

    // ── STEP 15: Return result ──────────────────────────────────────
    log(15, 'Pipeline complete');

    return {
      report_id: reportId,
      property_id: propertyId,
      decision: 'NEGOTIATE',
      decision_reasoning: 'Data-driven report — review findings and negotiate accordingly',
      was_resale: false,
    };

  } catch (err) {
    // Mark report as failed if we have one
    if (reportId) {
      await pool.query(
        "UPDATE property_reports SET status = 'failed' WHERE id = $1",
        [reportId]
      ).catch(() => {});
    } else if (propertyId) {
      // Create a failed report record for tracking
      await pool.query(
        `INSERT INTO property_reports (property_id, asking_price, decision, decision_reasoning, status)
         VALUES ($1, $2, 'WALK_AWAY', $3, 'failed')`,
        [propertyId, askingPrice, `Pipeline failed: ${err.message}`]
      ).catch(() => {});
    }

    log('ERR', `Pipeline failed: ${err.message}`);
    throw err;
  }
}

module.exports = {
  generateReport,
  generateTease,
  fetchHTML,
  isProperty24URL,
  extractProperty24Data,
  isPrivatePropertyURL,
  extractPrivatePropertyData,
};
