const https = require('https');
const http = require('http');
const Anthropic = require('@anthropic-ai/sdk');
const pool = require('./db');
const maps = require('./maps');
const windeed = require('./windeed');
const vision = require('./vision');
const { synthesiseReport } = require('./synthesis');
const { renderReport } = require('./pdf');

const anthropicClient = new Anthropic();

// ─── Logging ───────────────────────────────────────────────────────────

function log(step, message) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] STEP ${step.toString().padStart(2, '0')} — ${message}`);
}

// ─── Property24 scraping ───────────────────────────────────────────────

function fetchHTML(url) {
  const mod = url.startsWith('https') ? https : http;
  const parsed = new (require('url').URL)(url);
  const options = {
    hostname: parsed.hostname,
    path: parsed.pathname + parsed.search,
    headers: { 'User-Agent': 'SurePath/1.0 PropertyIntelligence' },
  };
  return new Promise((resolve, reject) => {
    mod.get(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchHTML(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
      }
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => resolve(body));
      res.on('error', reject);
    }).on('error', reject);
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
            if (item['@type'] === 'RealEstateListing' && item.about?.address) {
              const a = item.about.address;
              address = [a.streetAddress, a.addressLocality, a.addressRegion].filter(Boolean).join(', ');
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

    // Asking price
    let askingPrice = null;
    const priceMatch = bodyText.match(/R\s*([\d\s,]+)/);
    if (priceMatch) {
      const parsed = parseInt(priceMatch[1].replace(/[\s,]/g, ''));
      if (parsed >= 50000) askingPrice = parsed;
    }

    // Bedrooms, bathrooms, floor area
    const bedsMatch = bodyText.match(/(\d+)\s*Bed/i);
    const bathsMatch = bodyText.match(/(\d+)\s*Bath/i);
    const areaMatch = bodyText.match(/(\d+)\s*m²/);

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
      bedrooms: bedsMatch ? parseInt(bedsMatch[1]) : null,
      bathrooms: bathsMatch ? parseInt(bathsMatch[1]) : null,
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
    let nicoTease = "I couldn't pull a full photo preview on this one. The full report will cover everything.";

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

        const message = await anthropicClient.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 150,
          system: "You are Nico, a South African ex-property agent, aged 38-42. You are calm, direct, and slightly contrarian. You've seen a lot of properties and you don't sugarcoat things. Write exactly 2 sentences that tease the most important risk finding about this property without giving away the full detail. The reader is considering buying. Be honest but not alarmist. Do not mention AI. Do not use estate agent language. Do not say 'however' or 'that said'. Write in plain conversational South African English. If there are no risk flags, write 2 honest sentences about what looks reasonable and what a buyer should still verify in person.",
          messages: [{
            role: 'user',
            content: `Property: ${extractedData.address || 'unknown address'}. Asking price: R${extractedData.askingPrice ? extractedData.askingPrice.toLocaleString('en-ZA') : 'unknown'}. Top risk flags from photo analysis: ${flagsText}.`,
          }],
        });

        nicoTease = message.content[0].text;

        // Log cost
        try {
          const { logClaude } = require('./costs');
          await logClaude('claude-sonnet-4-6', message.usage.input_tokens, message.usage.output_tokens, 'tease/nico');
        } catch {}
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
    return {
      address: extractedData.address,
      askingPrice: extractedData.askingPrice,
      bedrooms: extractedData.bedrooms,
      bathrooms: extractedData.bathrooms,
      topRiskFlags: [],
      hasAsbestosRisk: false,
      hasStructuralFlags: false,
      nicoTease: "I couldn't pull a full photo preview on this one. The full report will cover everything.",
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
      log(1, `Fetching Property24 listing: ${input}`);
      const html = await fetchHTML(input);
      const extracted = extractProperty24Data(html);
      photoUrls = extracted.photoUrls;
      address = extracted.address;
      log(1, `Extracted ${photoUrls.length} photos, address: "${address}"`);

      if (!address) {
        throw new Error('Could not extract address from Property24 listing');
      }
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

    // Geocode
    log(1, 'Geocoding address...');
    const geo = await maps.geocode(address);
    if (geo) {
      log(1, `Geocoded: ${geo.lat}, ${geo.lng} — ${geo.suburb}, ${geo.city}, ${geo.province}`);
    } else {
      log(1, 'Geocoding failed — continuing without coordinates');
    }

    // ── STEP 02: Deeds lookup ───────────────────────────────────────
    log(2, 'Deeds lookup via Windeed');

    let deedsResult = null;
    try {
      deedsResult = await windeed.lookupAddress(address);
      if (deedsResult) {
        propertyId = deedsResult.property_id;
        log(2, `Deeds found: ERF ${deedsResult.erf_number}, owner: ${deedsResult.registered_owner}, municipal: R${deedsResult.municipal_value}`);
      } else {
        log(2, 'Windeed returned no results — creating property from geocode data');
      }
    } catch (err) {
      log(2, `Windeed error (non-fatal): ${err.message}`);
    }

    // If Windeed didn't create the property, find existing or create new
    if (!propertyId) {
      // Search for existing property by address match
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
        `UPDATE properties SET lat = $1, lng = $2, address_normalised = $3, suburb = $4, city = $5, province = $6 WHERE id = $7`,
        [geo.lat, geo.lng, geo.formatted_address, geo.suburb, geo.city, geo.province, propertyId]
      );
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
      log(3, `Recent report found: ID ${existing.id} — skipping to resale delivery`);

      // STEP 14 — Create resale order
      log(14, 'Creating resale order');
      await pool.query(
        `INSERT INTO orders (property_id, report_id, phone_number, price_zar, was_resale, payment_status)
         VALUES ($1, $2, $3, 149, TRUE, 'pending')`,
        [propertyId, existing.id, phoneNumber]
      );

      await pool.query(
        'UPDATE property_reports SET times_sold = times_sold + 1 WHERE id = $1',
        [existing.id]
      );

      log(15, 'Resale complete');
      return {
        report_id: existing.id,
        pdf_url: existing.pdf_url,
        decision: existing.decision,
        decision_reasoning: existing.decision_reasoning,
        was_resale: true,
      };
    }

    log(3, 'No recent report — generating fresh report');

    // ── STEP 04: Image collection ───────────────────────────────────
    log(4, 'Collecting images');

    // Store Property24 photos in property_images
    if (photoUrls.length > 0) {
      log(4, `Storing ${photoUrls.length} Property24 listing photos`);
      for (const url of photoUrls) {
        await pool.query(
          `INSERT INTO property_images (property_id, source, image_url, image_type)
           VALUES ($1, 'property24', $2, 'listing')`,
          [propertyId, url]
        );
      }
    }

    // Street View + Satellite
    let streetviewBase64 = null;
    let satelliteBase64 = null;

    if (geo) {
      log(4, 'Fetching Street View image...');
      streetviewBase64 = await maps.getStreetView(geo.lat, geo.lng);
      if (streetviewBase64) {
        await pool.query(
          `INSERT INTO property_images (property_id, source, image_url, image_type)
           VALUES ($1, 'streetview', $2, 'exterior')`,
          [propertyId, `data:image/jpeg;base64,${streetviewBase64.substring(0, 100)}...`]
        );
        log(4, 'Street View image stored');
      }

      log(4, 'Fetching satellite image...');
      satelliteBase64 = await maps.getSatelliteView(geo.lat, geo.lng);
      if (satelliteBase64) {
        await pool.query(
          `INSERT INTO property_images (property_id, source, image_url, image_type)
           VALUES ($1, 'satellite', $2, 'exterior')`,
          [propertyId, `data:image/png;base64,${satelliteBase64.substring(0, 100)}...`]
        );
        log(4, 'Satellite image stored');
      }
    } else {
      log(4, 'No coordinates — skipping Street View and satellite');
    }

    // ── STEP 05: Vision analysis — listing photos ───────────────────
    log(5, 'Vision analysis — listing photos');

    if (photoUrls.length > 0) {
      const listingVision = await vision.analyseWithHFPrestage(propertyId, photoUrls);
      if (listingVision) {
        log(5, `Analysed ${listingVision.analyses.length} listing photos, ${listingVision.aggregated.vision_findings.length} total findings`);
      } else {
        log(5, 'No listing photos analysed (download failures)');
      }
    } else {
      log(5, 'No listing photos to analyse');
    }

    // ── STEP 06: Vision analysis — Street View ──────────────────────
    log(6, 'Vision analysis — Street View');

    if (streetviewBase64) {
      const svAnalysis = await vision.analyseStreetView(streetviewBase64);
      // Store in property_images
      await pool.query(
        `UPDATE property_images SET vision_analysis = $1, analysed_at = NOW()
         WHERE id = (SELECT id FROM property_images WHERE property_id = $2 AND source = 'streetview' ORDER BY id DESC LIMIT 1)`,
        [JSON.stringify(svAnalysis), propertyId]
      );
      log(6, `Street View analysis: ${(svAnalysis.findings || []).length} findings`);
    } else {
      log(6, 'No Street View image — skipping');
    }

    // ── STEP 07: Vision analysis — satellite ────────────────────────
    log(7, 'Vision analysis — satellite');

    if (satelliteBase64) {
      const satAnalysis = await vision.analyseSatellite(satelliteBase64);
      await pool.query(
        `UPDATE property_images SET vision_analysis = $1, analysed_at = NOW()
         WHERE id = (SELECT id FROM property_images WHERE property_id = $2 AND source = 'satellite' ORDER BY id DESC LIMIT 1)`,
        [JSON.stringify(satAnalysis), propertyId]
      );
      log(7, `Satellite analysis: roof=${satAnalysis.roof_material}, solar=${satAnalysis.solar_installed}, orientation=${satAnalysis.roof_orientation_estimate}`);
    } else {
      log(7, 'No satellite image — skipping');
    }

    // ── STEP 08: AVM + comparables ──────────────────────────────────
    log(8, 'AVM + comparables — generated by Claude from property data and asking price');

    // ── STEP 09: Suburb intelligence ────────────────────────────────
    log(9, 'Suburb intelligence — queried from existing Surepath reports');

    // ── STEP 10: Building age risk matrix ───────────────────────────
    log(10, 'Building age risk matrix');

    const { rows: propRows } = await pool.query(
      'SELECT construction_era FROM properties WHERE id = $1',
      [propertyId]
    );
    const era = propRows[0]?.construction_era;
    log(10, `Construction era: ${era || 'unknown'} → age risk matrix applied`);

    // ── STEP 11: Report synthesis ───────────────────────────────────
    log(11, 'Report synthesis via Claude Opus');

    const synthesisResult = await synthesiseReport(propertyId, askingPrice);
    reportId = synthesisResult.report_id;
    const report = synthesisResult.report;
    log(11, `Report ${reportId} synthesised: decision=${report.decision}`);

    // ── STEP 12: B2B field propagation ──────────────────────────────
    log(12, 'B2B field propagation to properties table');

    // Already handled inside synthesiseReport, but log it
    log(12, 'Properties table updated with vision-derived fields');

    // ── STEP 13: PDF rendering ──────────────────────────────────────
    log(13, 'PDF rendering');

    const pdfUrl = await renderReport(reportId);
    log(13, `PDF generated: ${pdfUrl}`);

    // ── STEP 14: Create order record ────────────────────────────────
    log(14, 'Creating order record');

    await pool.query(
      `INSERT INTO orders (property_id, report_id, phone_number, price_zar, was_resale, payment_status)
       VALUES ($1, $2, $3, 149, FALSE, 'pending')`,
      [propertyId, reportId, phoneNumber]
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
      pdf_url: pdfUrl,
      decision: report.decision,
      decision_reasoning: report.decision_reasoning,
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
