const express = require('express');
const crypto = require('crypto');
const twilio = require('twilio');
const pool = require('./db');
const {
  generateReport,
  generateTease,
  fetchHTML,
  extractProperty24Data,
  extractPrivatePropertyData,
} = require('./pipeline');

const router = express.Router();

// Serve PDF reports so Twilio can fetch them for WhatsApp delivery
const reportPath = require('path').join(__dirname, 'reports');
const reportFs = require('fs');
if (!reportFs.existsSync(reportPath)) reportFs.mkdirSync(reportPath, { recursive: true });
// Serve reports with explicit Content-Type (bypasses ngrok interstitial for Twilio)
router.get('/reports/:filename', (req, res) => {
  const filePath = require('path').join(reportPath, req.params.filename);
  if (!require('fs').existsSync(filePath)) return res.status(404).send('Not found');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${req.params.filename}"`);
  res.setHeader('ngrok-skip-browser-warning', 'true');
  require('fs').createReadStream(filePath).pipe(res);
});

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER;
const PAYFAST_MERCHANT_ID = process.env.PAYFAST_MERCHANT_ID;
const PAYFAST_MERCHANT_KEY = process.env.PAYFAST_MERCHANT_KEY;

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ─── Helpers ───────────────────────────────────────────────────────────

async function sendWhatsApp(to, body, mediaUrl) {
  const phoneNumber = to.replace('whatsapp:', '');
  const msg = {
    from: `whatsapp:${TWILIO_WHATSAPP_NUMBER}`,
    to: to.startsWith('whatsapp:') ? to : `whatsapp:${to}`,
    body,
  };
  if (mediaUrl) msg.mediaUrl = [mediaUrl];
  const result = await twilioClient.messages.create(msg);
  // Log outbound message
  pool.query(
    'INSERT INTO whatsapp_messages (phone_number, direction, body, media_url, twilio_sid) VALUES ($1, $2, $3, $4, $5)',
    [phoneNumber, 'outbound', body, mediaUrl || null, result.sid]
  ).catch(err => console.error('[wa-log] Failed to log outbound:', err.message));
  return result;
}


function containsURL(text) {
  return /https?:\/\/[^\s]+/i.test(text);
}

function extractURL(text) {
  const match = text.match(/(https?:\/\/[^\s]+)/i);
  return match ? match[1] : null;
}

function parsePrice(text) {
  const cleaned = text.replace(/\s/g, '').toUpperCase();
  const millionMatch = cleaned.match(/R?(\d+\.?\d*)M/);
  if (millionMatch) return Math.round(parseFloat(millionMatch[1]) * 1_000_000);
  const numStr = cleaned.replace(/^R/, '').replace(/[,.\s]/g, '');
  const num = parseInt(numStr);
  return isNaN(num) ? null : num;
}

function isPrivatePropertyURL(text) {
  return /privateproperty\.co\.za|(?<![a-z])pp\.co\.za/i.test(text);
}

function isProperty24URL(text) {
  return /property24\.com/i.test(text);
}

function generatePayFastURL(orderId, amount) {
  const params = {
    merchant_id: PAYFAST_MERCHANT_ID,
    merchant_key: PAYFAST_MERCHANT_KEY,
    return_url: 'https://surepath.co.za/thankyou',
    cancel_url: 'https://surepath.co.za/cancelled',
    notify_url: `https://${process.env.SERVER_HOST || 'surepath.co.za'}/webhook/payfast`,
    m_payment_id: String(orderId),
    amount: amount.toFixed(2),
    item_name: 'Surepath Property Report',
  };

  const paramString = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v).trim())}`)
    .join('&');

  const signature = crypto.createHash('md5').update(paramString).digest('hex');
  return `https://www.payfast.co.za/eng/process?${paramString}&signature=${signature}`;
}

// ─── Conversation state machine ────────────────────────────────────────

async function getConversation(phoneNumber) {
  const { rows } = await pool.query(
    'SELECT * FROM conversations WHERE phone_number = $1',
    [phoneNumber]
  );
  return rows[0] || null;
}

async function upsertConversation(phoneNumber, updates) {
  const conv = await getConversation(phoneNumber);
  if (conv) {
    const setClauses = [];
    const values = [];
    let idx = 1;
    for (const [key, value] of Object.entries(updates)) {
      setClauses.push(`${key} = $${idx}`);
      values.push(key === 'photo_urls' ? JSON.stringify(value) : value);
      idx++;
    }
    setClauses.push(`updated_at = NOW()`);
    values.push(phoneNumber);
    await pool.query(
      `UPDATE conversations SET ${setClauses.join(', ')} WHERE phone_number = $${idx}`,
      values
    );
  } else {
    const fields = ['phone_number', ...Object.keys(updates)];
    const values = [phoneNumber, ...Object.values(updates).map(v =>
      Array.isArray(v) ? JSON.stringify(v) : v
    )];
    const placeholders = values.map((_, i) => `$${i + 1}`);
    await pool.query(
      `INSERT INTO conversations (${fields.join(', ')}) VALUES (${placeholders.join(', ')})`,
      values
    );
  }
}

// ─── Background tease generation ──────────────────────────────────────

async function runTeaseAsync(from, phoneNumber, url) {
  try {
    const isP24 = isProperty24URL(url);
    const isPP = isPrivatePropertyURL(url);

    if (!isP24 && !isPP) {
      throw new Error('Unrecognised listing URL');
    }

    // ── CHECK: Same user, same URL — reuse the tease we already sent them ──
    const conv = await getConversation(phoneNumber);
    if (conv?.tease_data && conv?.listing_url === url) {
      const tease = typeof conv.tease_data === 'string' ? JSON.parse(conv.tease_data) : conv.tease_data;
      if (tease.nicoTease) {
        console.log(`[tease] Same URL sent again by same user — reusing stored tease`);

        const address = tease.address;
        const priceFormatted = tease.askingPrice ? 'R' + Number(tease.askingPrice).toLocaleString('en-ZA') : 'Price not listed';
        const bedsLine = [
          tease.bedrooms ? `${tease.bedrooms} bed` : null,
          tease.bathrooms ? `${tease.bathrooms} bath` : null,
        ].filter(Boolean).join(' · ');

        await upsertConversation(phoneNumber, { state: 'tease_sent' });

        const message = [
          `*${address}*`,
          bedsLine ? `${bedsLine} · Asking ${priceFormatted}` : `Asking ${priceFormatted}`,
          '',
          tease.nicoTease,
          '',
          'The full Surepath report includes deeds history, crime stats, all risk flags, repair cost estimates, infrastructure data, and compliance requirements — every finding linked to its source.',
          '',
          'Reply *1* to get the full report (R149), or send a different listing link.',
        ].join('\n');

        await sendWhatsApp(from, message);
        return;
      }
    }

    // ── CHECK: Property exists in DB with vision data — generate tease from stored findings ──
    const { rows: existingProps } = await pool.query(
      `SELECT id, address_raw, address_normalised, asking_price, bedrooms, bathrooms FROM properties
       WHERE listing_url = $1
       ORDER BY id DESC LIMIT 1`,
      [url]
    );
    // For P24 URLs, also check if a PP record was cross-referenced from this P24 URL
    if (existingProps.length === 0 && isP24) {
      const { rows: crossRef } = await pool.query(
        `SELECT id, address_raw, address_normalised, asking_price, bedrooms, bathrooms FROM properties
         WHERE erf_number LIKE 'PP_%' AND listing_url LIKE '%privateproperty%'
         AND data_sources->>'p24_url' IS NOT NULL AND data_sources->'p24_url'->>'url' = $1
         ORDER BY id DESC LIMIT 1`,
        [url]
      );
      if (crossRef.length > 0) existingProps.push(...crossRef);
    }

    // Only use cached path if property has vision analysis (meaning it's been fully processed)
    const { rows: visionCheck } = existingProps.length > 0
      ? await pool.query('SELECT COUNT(*) AS c FROM property_images WHERE property_id = $1 AND vision_analysis IS NOT NULL', [existingProps[0].id])
      : [{ c: '0' }];

    if (existingProps.length > 0 && parseInt(visionCheck[0].c) > 0) {
      const p = existingProps[0];
      const propertyId = p.id;
      console.log(`[tease] Found existing property ${propertyId} with ${visionCheck[0].c} analysed photos — using stored findings`);

      // Refresh property data from listing in case it's stale
      try {
        const freshData = isPP ? await extractPrivatePropertyData(url) : null;
        if (freshData?.address) {
          await pool.query(
            `UPDATE properties SET address_raw = COALESCE($1, address_raw), asking_price = COALESCE($2, asking_price), bedrooms = COALESCE($3, bedrooms), bathrooms = COALESCE($4, bathrooms) WHERE id = $5`,
            [freshData.address, freshData.askingPrice, freshData.bedrooms, freshData.bathrooms, propertyId]
          );
          // Re-fetch updated data
          const { rows: refreshed } = await pool.query('SELECT address_raw, address_normalised, asking_price, bedrooms, bathrooms FROM properties WHERE id = $1', [propertyId]);
          if (refreshed.length > 0) Object.assign(p, refreshed[0]);
        }
      } catch (e) { console.error(`[tease] Refresh error (non-fatal): ${e.message}`); }

      // Gather top risk flags from stored vision analysis
      const { rows: imgFindings } = await pool.query(
        "SELECT vision_analysis FROM property_images WHERE property_id = $1 AND vision_analysis IS NOT NULL AND vision_analysis::text != '{}' AND jsonb_array_length(COALESCE(vision_analysis->'findings', '[]'::jsonb)) > 0",
        [propertyId]
      );

      const topRiskFlags = [];
      for (const img of imgFindings) {
        const va = typeof img.vision_analysis === 'string' ? JSON.parse(img.vision_analysis) : img.vision_analysis;
        for (const f of (va?.findings || [])) {
          if ((f.severity === 'CRITICAL' || f.severity === 'HIGH') && f.observation) {
            topRiskFlags.push(f.observation);
          }
        }
      }

      // Generate Nico tease from stored findings
      const address = p.address_normalised || p.address_raw;
      const flagsText = topRiskFlags.length > 0
        ? topRiskFlags.slice(0, 3).join('; ')
        : 'no risk flags found';

      let nicoTease;
      try {
        const Anthropic = require('@anthropic-ai/sdk');
        const client = new Anthropic();
        const resp = await client.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 150,
          system: "You are Nico, a South African ex-property agent, aged 38-42. You are calm, direct, and slightly contrarian. Write exactly 2 sentences about this property for a potential buyer. Be honest but never alarmist or discouraging. NEVER say the buyer is 'buying blind', NEVER suggest the report is inadequate, NEVER mention missing data or street view. Do not invent problems — only reference risk flags that were actually provided. If there are no risk flags, comment positively on the property details (size, location, bedrooms, price). Do NOT mention the full report, Surepath, deeds, crime stats, or what the report covers — that information is added separately after your text. Do not mention AI. Do not use estate agent language. Write in plain conversational South African English. Focus only on what you can observe about this specific property.",
          messages: [{ role: 'user', content: `Property: ${address}. Asking price: R${p.asking_price ? Number(p.asking_price).toLocaleString('en-ZA') : 'unknown'}. Risk flags: ${flagsText}.` }],
        });
        nicoTease = resp.content[0].text;
      } catch (err) {
        console.error(`[tease] Claude tease generation failed: ${err.message}`);
        nicoTease = topRiskFlags.length > 0
          ? `Key concerns: ${topRiskFlags.slice(0, 2).map(f => f.split('.')[0]).join('. ')}.`
          : 'Photos look clean from what we can see. The full report covers deeds, crime, infrastructure and more.';
      }

      const priceFormatted = p.asking_price ? 'R' + Number(p.asking_price).toLocaleString('en-ZA') : 'Price not listed';
      const bedsLine = [
        p.bedrooms ? `${p.bedrooms} bed` : null,
        p.bathrooms ? `${p.bathrooms} bath` : null,
      ].filter(Boolean).join(' · ');

      await upsertConversation(phoneNumber, {
        state: 'tease_sent',
        tease_data: JSON.stringify({ address, askingPrice: p.asking_price, bedrooms: p.bedrooms, bathrooms: p.bathrooms, topRiskFlags: topRiskFlags.slice(0, 3), nicoTease, photoCount: 0 }),
        asking_price: p.asking_price || null,
        listing_url: url,
      });

      const message = [
        `*${address}*`,
        bedsLine ? `${bedsLine} · Asking ${priceFormatted}` : `Asking ${priceFormatted}`,
        '',
        nicoTease,
        '',
        'The full Surepath report includes deeds history, crime stats, all risk flags, repair cost estimates, infrastructure data, and compliance requirements — every finding linked to its source.',
        '',
        'Reply *1* to get the full report (R149), or send a different listing link.',
      ].join('\n');

      await sendWhatsApp(from, message);
      return;
    }

    // ── No existing property — scrape and generate fresh tease ──
    let extractedData;
    let resolvedUrl = url; // may change to PP URL if we find a match

    if (isP24) {
      console.log(`[tease] Property24 URL — extracting OG metadata and cross-referencing`);

      // Step 1: Fetch P24 page with simple HTTP GET and extract OG meta tags
      // No Puppeteer needed — P24 blocks scrapers, but OG tags are in the static HTML
      let p24Data = null;
      try {
        const html = await fetchHTML(url);

        // Extract OG meta tags
        const ogImage = (html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
                         html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i) || [])[1] || null;
        const ogTitle = (html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
                         html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i) || [])[1] || null;
        const ogDesc = (html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i) ||
                        html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i) || [])[1] || null;

        // Parse title — P24 OG titles are like "8 Bedroom House for sale in Helderberg Estate - Somerset West"
        const title = ogTitle || '';
        const titleBedsM = title.match(/(\d+)\s*Bed/i);
        const bedrooms = titleBedsM ? parseInt(titleBedsM[1]) : null;
        const bathsM = (ogDesc || '').match(/(\d+)\s*Bath/i);
        const bathrooms = bathsM ? parseInt(bathsM[1]) : null;

        // Price from OG description or page content
        let price = null;
        const priceText = (ogDesc || '').match(/R\s*([\d\s,]+)/);
        if (priceText) {
          const parsed = parseInt(priceText[1].replace(/[\s,]/g, ''));
          if (parsed >= 100000 && parsed <= 500000000) price = parsed;
        }

        // Property type from title
        const tLower = title.toLowerCase();
        let propertyType = null;
        if (tLower.includes('apartment') || tLower.includes('flat')) propertyType = 'sectional';
        else if (tLower.includes('house') && !tLower.includes('townhouse')) propertyType = 'freehold';
        else if (tLower.includes('townhouse') || tLower.includes('cluster')) propertyType = 'estate';

        // Street address from JSON-LD (still in static HTML)
        let streetAddress = null;
        let listingName = null;
        try {
          const jsonldMatches = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
          for (const block of jsonldMatches) {
            const jsonStr = block.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '');
            const ld = JSON.parse(jsonStr);
            if (ld.address?.streetAddress) streetAddress = ld.address.streetAddress;
            if (ld.name) listingName = ld.name;
          }
        } catch {}

        // Also try to extract street address from OG title
        // Pattern: "8 Bedroom House for sale in Linden - 79 Third Street - Randburg - Property24"
        if (!streetAddress && ogTitle) {
          const titleParts = ogTitle.replace(/\s*-\s*Property24.*$/i, '').split(/\s*-\s*/);
          // If there are 3+ parts, the middle ones might be street addresses
          // First part is "X Bedroom House for sale in Suburb", last is city
          if (titleParts.length >= 3) {
            // Parts between suburb and city are likely street address
            streetAddress = titleParts.slice(1, -1).join(', ');
          }
        }

        p24Data = {
          title: ogTitle || title,
          price,
          bedrooms,
          bathrooms,
          propertyType,
          streetAddress,
          listingName,
          ogImage,            // the thumbnail from the link preview
          photos: ogImage ? [ogImage] : [],
          description: ogDesc,
        };

        console.log(`[tease] P24 OG extracted: "${p24Data.title}", R${p24Data.price}, ${p24Data.bedrooms}bed, ogImage: ${ogImage ? 'yes' : 'no'}`);
      } catch (err) {
        console.error(`[tease] P24 fetch failed: ${err.message}`);
        p24Data = { title: null, photos: [], price: null, bedrooms: null, bathrooms: null, ogImage: null };
      }

      // Step 2: Extract suburb from P24 URL
      // P24 URL format: /for-sale/{suburb}/{city}/{province}/{code}/{id}
      const p24Parts = url.match(/property24\.com\/for-sale\/([^/]+)\/([^/]+)\/([^/]+)/);
      const p24Suburb = p24Parts ? p24Parts[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : null;
      const p24City = p24Parts ? p24Parts[2].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : null;

      // Step 3: Match P24 to PP via local database
      // Priority: street address > suburb+beds+price > fallback
      let matchedPropertyId = null;

      // Normalize street for matching: "79 Third Street" → "79-third", "79-3rd"
      const streetRaw = (p24Data.streetAddress || '').toLowerCase().replace(/\s+street$/i, '').replace(/\s+road$/i, '').replace(/\s+avenue$/i, '').replace(/\s+drive$/i, '').trim();
      const streetNorm = streetRaw.replace(/\s+/g, '-');
      // Also create numeric-ordinal variant: "third" → "3rd", "first" → "1st"
      const ordinals = { first: '1st', second: '2nd', third: '3rd', fourth: '4th', fifth: '5th', sixth: '6th', seventh: '7th', eighth: '8th', ninth: '9th', tenth: '10th' };
      const streetOrdinal = streetNorm.replace(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/g, m => ordinals[m]);

      console.log(`[tease] Matching P24 → PP: suburb="${p24Suburb}", beds=${p24Data.bedrooms}, price=R${p24Data.price}, street="${streetRaw || 'none'}"`);

      // Strategy 1: Street address match in PP listing URL (strongest signal)
      if (streetNorm && p24Suburb) {
        const streetPatterns = [streetOrdinal, streetNorm].filter((v, i, a) => a.indexOf(v) === i);
        for (const pattern of streetPatterns) {
          if (matchedPropertyId) break;
          const { rows: streetMatches } = await pool.query(
            `SELECT id, address_raw, asking_price, bedrooms, listing_url FROM properties
             WHERE erf_number LIKE 'PP_%'
             AND listing_url ILIKE $1
             AND (suburb ILIKE $2 OR listing_url ILIKE $3)
             ORDER BY id DESC LIMIT 5`,
            [`%/${pattern}/%`, p24Suburb, `%/${p24Suburb.toLowerCase().replace(/\s+/g, '-')}/%`]
          );

          if (streetMatches.length > 0) {
            // If multiple matches at same street, narrow by bedrooms
            let best = streetMatches[0];
            if (streetMatches.length > 1 && p24Data.bedrooms) {
              const bedsMatch = streetMatches.find(r => r.bedrooms === p24Data.bedrooms);
              if (bedsMatch) best = bedsMatch;
            }
            matchedPropertyId = best.id;
            resolvedUrl = best.listing_url || url;
            console.log(`[tease] STRONG MATCH (street address): property ${matchedPropertyId} "${best.address_raw}" via URL pattern "${pattern}"`);
          }
        }
      }

      // Strategy 2: Street address match in address_raw field
      if (!matchedPropertyId && streetRaw && p24Suburb) {
        const { rows: addrMatches } = await pool.query(
          `SELECT id, address_raw, asking_price, bedrooms, listing_url FROM properties
           WHERE erf_number LIKE 'PP_%'
           AND (suburb ILIKE $1 OR city ILIKE $1)
           AND (address_raw ILIKE $2 OR address_raw ILIKE $3)
           ORDER BY id DESC LIMIT 5`,
          [p24Suburb, `%${streetRaw}%`, `%${streetRaw.replace(/\s+/g, '%')}%`]
        );

        if (addrMatches.length > 0) {
          let best = addrMatches[0];
          if (addrMatches.length > 1 && p24Data.bedrooms) {
            const bedsMatch = addrMatches.find(r => r.bedrooms === p24Data.bedrooms);
            if (bedsMatch) best = bedsMatch;
          }
          matchedPropertyId = best.id;
          resolvedUrl = best.listing_url || url;
          console.log(`[tease] STRONG MATCH (address_raw): property ${matchedPropertyId} "${best.address_raw}"`);
        }
      }

      // Strategy 3: Suburb + bedrooms + price range (weaker, only if unique match)
      if (!matchedPropertyId && p24Data.bedrooms && p24Data.price) {
        const searchTerms = [p24Suburb, p24City].filter(Boolean);
        for (const term of searchTerms) {
          if (matchedPropertyId) break;
          const { rows: matchRows } = await pool.query(
            `SELECT id, address_raw, asking_price, bedrooms, listing_url FROM properties
             WHERE (suburb ILIKE $1 OR city ILIKE $1) AND bedrooms = $2
             AND asking_price BETWEEN $3 * 0.85 AND $3 * 1.15
             AND erf_number LIKE 'PP_%'
             ORDER BY ABS(asking_price - $3) LIMIT 5`,
            [term, p24Data.bedrooms, p24Data.price]
          );

          if (matchRows.length === 1) {
            // Only accept if there's exactly one match — avoids ambiguity
            matchedPropertyId = matchRows[0].id;
            resolvedUrl = matchRows[0].listing_url || url;
            console.log(`[tease] MATCH (suburb+beds+price, unique): property ${matchedPropertyId} "${matchRows[0].address_raw}" via "${term}"`);
          } else if (matchRows.length > 1) {
            console.log(`[tease] ${matchRows.length} candidates for ${term}/${p24Data.bedrooms}bed/R${p24Data.price} — too ambiguous, skipping`);
          }
        }
      }

      // Strategy 4: Suburb + bedrooms only (even weaker, only if unique)
      if (!matchedPropertyId && p24Data.bedrooms && !p24Data.price) {
        const { rows: bedsOnly } = await pool.query(
          `SELECT id, address_raw, asking_price, bedrooms, listing_url FROM properties
           WHERE (suburb ILIKE $1 OR city ILIKE $1) AND bedrooms = $2
           AND erf_number LIKE 'PP_%'
           LIMIT 2`,
          [p24Suburb, p24Data.bedrooms]
        );
        if (bedsOnly.length === 1) {
          matchedPropertyId = bedsOnly[0].id;
          resolvedUrl = bedsOnly[0].listing_url || url;
          console.log(`[tease] MATCH (suburb+beds only, unique): property ${matchedPropertyId} "${bedsOnly[0].address_raw}"`);
        }
      }

      if (matchedPropertyId) {
        await pool.query(
          "UPDATE properties SET data_sources = COALESCE(data_sources, '{}'::jsonb) || $1::jsonb WHERE id = $2",
          [JSON.stringify({ p24_url: { name: 'Property24 URL', url, confidence: 'cross-referenced', date: new Date().toISOString() } }), matchedPropertyId]
        );
      } else {
        console.log(`[tease] No PP match in local DB for ${p24Suburb}/${p24City} ${p24Data.bedrooms}bed R${p24Data.price} street="${streetRaw || 'none'}"`);
      }

      // Step 4: If no local match, use Google Vision reverse image search with OG thumbnail
      if (!matchedPropertyId && p24Data.ogImage) {
        try {
          const { reverseImageSearch } = require('./match-p24-to-pp');
          console.log(`[tease] Reverse image searching P24 OG thumbnail...`);
          const matchingPages = await reverseImageSearch(p24Data.ogImage);
          const ppPages = matchingPages.filter(u => u.includes('privateproperty.co.za/for-sale/'));

          // Find PP listing URLs (may be multiple candidates)
          const ppCandidates = [];
          for (const ppPage of ppPages) {
            const tMatch = ppPage.match(/(https?:\/\/www\.privateproperty\.co\.za\/for-sale\/[^?#]+\/T\d+)/);
            if (tMatch && !ppCandidates.includes(tMatch[1])) ppCandidates.push(tMatch[1]);
          }

          // Validate each candidate — must match suburb and bedrooms from P24
          let bestPPUrl = null;
          for (const candidateUrl of ppCandidates) {
            console.log(`[tease] Checking PP candidate: ${candidateUrl}`);
            const ppExtracted = await extractPrivatePropertyData(candidateUrl);
            if (!ppExtracted?.address) continue;

            // Validate: suburb must match
            // PP URL: /for-sale/{province}/{region}/{city}/{suburb}/{optional-street}/{T-id}
            const ppUrlParts = candidateUrl.replace(/.*\/for-sale\//, '').split('/');
            const ppSuburb = (ppUrlParts[3] || '').replace(/-/g, ' ').toLowerCase();
            const ppCity = (ppUrlParts[2] || '').replace(/-/g, ' ').toLowerCase();
            const p24SuburbLower = (p24Suburb || '').toLowerCase();
            const p24CityLower = (p24City || '').toLowerCase();
            const suburbMatch = ppSuburb && p24SuburbLower && (
              ppSuburb.includes(p24SuburbLower) || p24SuburbLower.includes(ppSuburb)
            );
            // Also check city matches (prevents cross-city false matches)
            const cityMatch = !p24CityLower || !ppCity || ppCity.includes(p24CityLower) || p24CityLower.includes(ppCity);

            // Validate: bedrooms must match (if we have both)
            const bedsMatch = !p24Data.bedrooms || !ppExtracted.bedrooms || p24Data.bedrooms === ppExtracted.bedrooms;

            // Validate: street address if available
            const p24Street = (p24Data.streetAddress || '').toLowerCase().split(',')[0].trim();
            const ppAddress = (ppExtracted.address || '').toLowerCase();
            const streetMatch = !p24Street || ppAddress.includes(p24Street) || candidateUrl.toLowerCase().includes(p24Street.replace(/\s+/g, '-'));

            console.log(`[tease]   suburb: ${ppSuburb} vs ${p24SuburbLower} (${suburbMatch ? 'OK' : 'MISMATCH'}), city: ${ppCity} vs ${p24CityLower} (${cityMatch ? 'OK' : 'MISMATCH'}), beds: ${ppExtracted.bedrooms} vs ${p24Data.bedrooms} (${bedsMatch ? 'OK' : 'MISMATCH'}), street: ${streetMatch ? 'OK' : 'MISMATCH'}`);

            if (suburbMatch && cityMatch && bedsMatch) {
              bestPPUrl = candidateUrl;
              extractedData = ppExtracted;
              resolvedUrl = candidateUrl;
              console.log(`[tease] Verified PP match: ${ppExtracted.address}, R${ppExtracted.askingPrice}`);
              break;
            } else {
              console.log(`[tease]   Rejected — wrong property`);
            }
          }

          if (!bestPPUrl && ppCandidates.length > 0) {
            console.log(`[tease] ${ppCandidates.length} PP candidates found but none matched suburb/beds — using P24 data`);
          } else if (ppCandidates.length === 0) {
            console.log(`[tease] No PP listing URLs found via OG image search`);
          }

          // Log the cost
          try {
            const { logGoogle } = require('./costs');
            if (logGoogle) await logGoogle('google_vision_web_detection', 1, null);
          } catch {}
        } catch (err) {
          console.log(`[tease] Image match failed: ${err.message}`);
        }
      }

      // Step 5: If we matched a local property, use the existing-property tease path
      if (matchedPropertyId) {
        // Re-enter the existing-property path with this matched ID
        const { rows: matchProps } = await pool.query(
          'SELECT id, address_raw, address_normalised, asking_price, bedrooms, bathrooms FROM properties WHERE id = $1',
          [matchedPropertyId]
        );
        if (matchProps.length > 0) {
          const p = matchProps[0];
          // Re-run the existing property tease logic (same as the cached-property path above)
          const { rows: imgFindings } = await pool.query(
            "SELECT vision_analysis FROM property_images WHERE property_id = $1 AND vision_analysis IS NOT NULL AND vision_analysis::text != '{}' AND jsonb_array_length(COALESCE(vision_analysis->'findings', '[]'::jsonb)) > 0",
            [matchedPropertyId]
          );
          const topRiskFlags = [];
          for (const img of imgFindings) {
            const va = typeof img.vision_analysis === 'string' ? JSON.parse(img.vision_analysis) : img.vision_analysis;
            for (const f of (va?.findings || [])) {
              if ((f.severity === 'CRITICAL' || f.severity === 'HIGH') && f.observation) topRiskFlags.push(f.observation);
            }
          }

          // Refresh from PP listing
          try {
            if (resolvedUrl !== url) {
              const freshData = await extractPrivatePropertyData(resolvedUrl);
              if (freshData?.address) {
                await pool.query('UPDATE properties SET address_raw = COALESCE($1, address_raw), asking_price = COALESCE($2, asking_price), bedrooms = COALESCE($3, bedrooms), bathrooms = COALESCE($4, bathrooms) WHERE id = $5',
                  [freshData.address, freshData.askingPrice, freshData.bedrooms, freshData.bathrooms, matchedPropertyId]);
                const { rows: refreshed } = await pool.query('SELECT address_raw, address_normalised, asking_price, bedrooms, bathrooms FROM properties WHERE id = $1', [matchedPropertyId]);
                if (refreshed.length > 0) Object.assign(p, refreshed[0]);
              }
            }
          } catch {}

          const address = p.address_normalised || p.address_raw;
          const flagsText = topRiskFlags.length > 0 ? topRiskFlags.slice(0, 3).join('; ') : 'no risk flags found';
          const propertyDetails = [p.bedrooms ? `${p.bedrooms} bedrooms` : null, p.bathrooms ? `${p.bathrooms} bathrooms` : null].filter(Boolean).join(', ');
          let nicoTease;
          try {
            const Anthropic = require('@anthropic-ai/sdk');
            const client = new Anthropic();
            const resp = await client.messages.create({
              model: 'claude-sonnet-4-6', max_tokens: 150,
              system: "You are Nico, a South African ex-property agent, aged 38-42. You are calm, direct, and slightly contrarian. Write exactly 2 sentences about this property for a potential buyer. Be honest but never alarmist or discouraging. NEVER say the buyer is \"buying blind\", NEVER suggest the report is inadequate, NEVER mention missing data or street view. Do not invent problems — only reference risk flags that were actually provided. If there are no risk flags, comment positively on the property details (size, location, bedrooms, price). Do NOT mention the full report, Surepath, deeds, crime stats, or what the report covers — that information is added separately after your text. Do not mention AI. Do not use estate agent language. Write in plain conversational South African English. Focus only on what you can observe about this specific property.",
              messages: [{ role: 'user', content: `Property: ${address}. ${propertyDetails}. Asking price: R${p.asking_price ? Number(p.asking_price).toLocaleString('en-ZA') : 'unknown'}. Risk flags: ${flagsText}.` }],
            });
            nicoTease = resp.content[0].text;
          } catch { nicoTease = `${propertyDetails || 'This property'} in ${(address || '').split(',')[0]} at R${p.asking_price ? Number(p.asking_price).toLocaleString('en-ZA') : 'unknown'} — the full report covers deeds history, crime stats, structural risks, and compliance.`; }

          const priceFormatted = p.asking_price ? 'R' + Number(p.asking_price).toLocaleString('en-ZA') : 'Price not listed';
          const bedsLine = [p.bedrooms ? `${p.bedrooms} bed` : null, p.bathrooms ? `${p.bathrooms} bath` : null].filter(Boolean).join(' · ');

          await upsertConversation(phoneNumber, {
            state: 'tease_sent',
            tease_data: JSON.stringify({ address, askingPrice: p.asking_price, bedrooms: p.bedrooms, bathrooms: p.bathrooms, topRiskFlags: topRiskFlags.slice(0, 3), nicoTease, photoCount: 0 }),
            asking_price: p.asking_price || null,
            listing_url: resolvedUrl,
            input_data: resolvedUrl,
          });

          const message = [
            `*${address}*`,
            bedsLine ? `${bedsLine} · Asking ${priceFormatted}` : `Asking ${priceFormatted}`,
            '',
            nicoTease,
            '',
            'The full Surepath report includes deeds history, crime stats, all risk flags, repair cost estimates, infrastructure data, and compliance requirements — every finding linked to its source.',
            '',
            'Reply *1* to get the full report (R149), or send a different listing link.',
          ].join('\n');

          await sendWhatsApp(from, message);
          return;
        }
      }

      // Step 6: No PP match found — Puppeteer-scrape P24 for full photos before offering the report
      if (!extractedData) {
        console.log(`[tease] No PP match — scraping P24 with Puppeteer to get all photos`);

        let p24Photos = p24Data.photos || [];
        let p24Price = p24Data.price;
        let p24Street = p24Data.streetAddress;
        let p24Desc = p24Data.description;

        try {
          const puppeteer = require('puppeteer');
          const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
          const p24Page = await browser.newPage();
          await p24Page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
          await p24Page.goto(url, { waitUntil: 'networkidle0', timeout: 25000 });

          const scraped = await p24Page.evaluate(() => {
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

            // Price
            const allEls = document.querySelectorAll('*');
            for (const el of allEls) {
              const t = el.textContent?.trim() || '';
              if (/^R\s*[\d\s,]+$/.test(t)) {
                const p = parseInt(t.replace(/\D/g, ''));
                if (p >= 100000 && p <= 500000000) { r.price = p; break; }
              }
            }

            // Beds/baths/street
            const body = document.body.innerText;
            const bedsM = body.match(/(\d+)\s*Bed/i);
            const bathsM = body.match(/(\d+)\s*Bath/i);
            r.bedrooms = bedsM ? parseInt(bedsM[1]) : null;
            r.bathrooms = bathsM ? parseInt(bathsM[1]) : null;
            try {
              document.querySelectorAll('script[type="application/ld+json"]').forEach(el => {
                const ld = JSON.parse(el.innerHTML);
                if (ld.address?.streetAddress) r.streetAddress = ld.address.streetAddress;
              });
            } catch {}

            // Description
            const descEl = document.querySelector('[class*="description"], [class*="listing-body"]');
            r.description = descEl ? descEl.textContent?.trim()?.substring(0, 2000) : null;

            return r;
          });

          await browser.close();

          if (scraped.photos.length > 0) p24Photos = scraped.photos;
          if (scraped.price && !p24Price) p24Price = scraped.price;
          if (scraped.streetAddress && !p24Street) p24Street = scraped.streetAddress;
          if (scraped.description && !p24Desc) p24Desc = scraped.description;
          if (scraped.bedrooms && !p24Data.bedrooms) p24Data.bedrooms = scraped.bedrooms;
          if (scraped.bathrooms && !p24Data.bathrooms) p24Data.bathrooms = scraped.bathrooms;

          console.log(`[tease] P24 Puppeteer: ${p24Photos.length} photos, R${p24Price || '?'}`);
        } catch (err) {
          console.error(`[tease] P24 Puppeteer failed: ${err.message} — using OG data`);
        }

        const p24Address = p24Street
          ? `${p24Street}, ${p24Suburb || ''}, ${p24City || ''}`
          : p24Data.title
            ? `${p24Data.title.replace(/\s+for\s+sale\s*/i, ' in ').replace(/\s+in\s+in\s+/i, ' in ')}, ${p24City || ''}`
            : `Property in ${p24Suburb || 'unknown'}`;

        extractedData = {
          address: p24Address.replace(/, $/, ''),
          askingPrice: p24Price,
          bedrooms: p24Data.bedrooms,
          bathrooms: p24Data.bathrooms,
          photoUrls: p24Photos,
          description: p24Desc,
          listingId: null,
        };
        console.log(`[tease] P24 final: "${extractedData.address}", R${extractedData.askingPrice}, ${extractedData.bedrooms}bed, ${extractedData.photoUrls.length} photos`);
      }
    } else {
      extractedData = await extractPrivatePropertyData(url);
    }

    if (!extractedData || !extractedData.address) {
      throw new Error('Could not extract listing data');
    }

    // Create property record immediately so it appears in the system
    try {
      // Use resolved URL (may be PP URL if cross-referenced from P24)
      const storeUrl = resolvedUrl || url;

      // Extract suburb/city from the URL we're storing
      const urlForParts = storeUrl.includes('privateproperty') ? storeUrl : url;
      const urlParts = urlForParts.replace(/.*\/for-sale\//, '').split('/');
      let urlSuburb = null, urlCity = null, urlProvince = null;
      if (urlForParts.includes('privateproperty') && urlParts.length >= 5) {
        urlProvince = urlParts[0].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        urlCity = urlParts[2].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        urlSuburb = urlParts[3].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      } else if (urlForParts.includes('property24') && urlParts.length >= 3) {
        urlSuburb = urlParts[0].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        urlCity = urlParts[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        urlProvince = urlParts[2].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      }

      const ppMatch = storeUrl.match(/(T\d+)/);
      const p24Match = url.match(/\/(\d{6,})(?:\/|$)/);
      const erfNumber = ppMatch ? `PP_${ppMatch[1]}` : p24Match ? `P24_${p24Match[1]}` : `WA_${Date.now()}`;

      await pool.query(
        `INSERT INTO properties (erf_number, address_raw, listing_url, asking_price, bedrooms, bathrooms, suburb, city, province, description)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (erf_number) DO UPDATE SET
           listing_url = COALESCE(EXCLUDED.listing_url, properties.listing_url),
           asking_price = COALESCE(EXCLUDED.asking_price, properties.asking_price),
           bedrooms = COALESCE(EXCLUDED.bedrooms, properties.bedrooms),
           bathrooms = COALESCE(EXCLUDED.bathrooms, properties.bathrooms),
           suburb = COALESCE(EXCLUDED.suburb, properties.suburb),
           city = COALESCE(EXCLUDED.city, properties.city),
           province = COALESCE(EXCLUDED.province, properties.province),
           description = COALESCE(NULLIF(EXCLUDED.description, ''), properties.description)`,
        [erfNumber, extractedData.address, storeUrl, extractedData.askingPrice || null,
         extractedData.bedrooms || null, extractedData.bathrooms || null,
         urlSuburb, urlCity, urlProvince, extractedData.description || null]
      );

      // Store photos
      if (extractedData.photoUrls?.length > 0) {
        const source = storeUrl.includes('privateproperty') ? 'privateproperty' : 'property24';
        for (const photoUrl of extractedData.photoUrls) {
          await pool.query(
            `INSERT INTO property_images (property_id, source, image_url, image_type)
             SELECT id, $2, $3, 'listing' FROM properties WHERE erf_number = $1
             ON CONFLICT (property_id, image_url) DO NOTHING`,
            [erfNumber, source, photoUrl]
          ).catch(() => {});
        }
      }

      // Record provenance for all fields
      const { rows: propId } = await pool.query('SELECT id FROM properties WHERE erf_number = $1', [erfNumber]);
      if (propId.length > 0) {
        const provenance = require('./provenance');
        const listingSource = isPP ? 'PrivateProperty Listing' : 'Property24 Listing';
        const fields = ['erf_number', 'address_raw', 'listing_url'];
        if (urlSuburb) fields.push('suburb');
        if (urlCity) fields.push('city');
        if (urlProvince) fields.push('province');
        if (extractedData.askingPrice) fields.push('asking_price');
        if (extractedData.bedrooms) fields.push('bedrooms');
        if (extractedData.bathrooms) fields.push('bathrooms');
        await provenance.recordSource(propId[0].id, listingSource, url, 'scraped', fields);
      }

      console.log(`[tease] Created/updated property ${erfNumber} from WhatsApp tease`);
    } catch (err) {
      console.error(`[tease] Property creation error (non-fatal): ${err.message}`);
    }

    // Generate tease
    const tease = await generateTease(extractedData);

    // Store tease in conversation — include input_data and listing_url so report generation works
    await upsertConversation(phoneNumber, {
      state: 'tease_sent',
      tease_data: JSON.stringify(tease),
      asking_price: tease.askingPrice || null,
      pp_listing_id: extractedData.listingId || null,
      listing_url: resolvedUrl || url,
      input_data: resolvedUrl || url,
    });

    // Format and send tease message
    const priceFormatted = tease.askingPrice
      ? 'R' + tease.askingPrice.toLocaleString('en-ZA')
      : 'Price not listed';

    const bedsLine = [
      tease.bedrooms ? `${tease.bedrooms} bed` : null,
      tease.bathrooms ? `${tease.bathrooms} bath` : null,
    ].filter(Boolean).join(' · ');

    const message = [
      `*${tease.address}*`,
      bedsLine ? `${bedsLine} · Asking ${priceFormatted}` : `Asking ${priceFormatted}`,
      '',
      tease.nicoTease,
      '',
      'The full Surepath report includes deeds history, crime stats, all risk flags, repair cost estimates, infrastructure data, and compliance requirements — every finding linked to its source.',
      '',
      'Reply *1* to get the full report (R149), or send a different listing link.',
    ].join('\n');

    await sendWhatsApp(from, message);

  } catch (err) {
    console.error(`[tease] Failed for ${phoneNumber}:`, err.message);

    await upsertConversation(phoneNumber, { state: 'awaiting_property' });

    await sendWhatsApp(from,
      "I couldn't pull that listing automatically — it may have been removed or the link is broken.\n\nTry sending the property address directly, or paste a different listing link."
    );
  }
}

// ─── WhatsApp webhook (POST /webhook/whatsapp) ────────────────────────

router.post('/webhook/whatsapp', express.urlencoded({ extended: false }), async (req, res) => {
  const from = req.body.From;
  const body = (req.body.Body || '').trim();
  const phoneNumber = from.replace('whatsapp:', '');

  console.log(`[whatsapp] ${phoneNumber}: "${body}"`);

  // Log inbound message
  pool.query(
    'INSERT INTO whatsapp_messages (phone_number, direction, body) VALUES ($1, $2, $3)',
    [phoneNumber, 'inbound', body]
  ).catch(err => console.error('[wa-log] Failed to log inbound:', err.message));

  try {
    const conv = await getConversation(phoneNumber);
    const state = conv ? conv.state : 'awaiting_property';
    const normalised = body.toLowerCase().trim();
    const url = extractURL(body);
    const hasListingURL = url && (isProperty24URL(url) || isPrivatePropertyURL(url));

    // ── If generating/scraping but user sends a NEW listing URL, start fresh ──
    if ((state === 'generating' || state === 'scraping') && hasListingURL && conv?.listing_url !== url) {
      console.log(`[whatsapp] New URL while ${state} — resetting to new tease`);
      await sendWhatsApp(from, 'Got it — checking this property now. ⏳');
      await upsertConversation(phoneNumber, {
        state: 'scraping',
        input_data: url,
        listing_url: url,
        tease_data: null,
      });
      runTeaseAsync(from, phoneNumber, url);
      res.type('text/xml').send('<Response></Response>');
      return;
    }

    // ── If generating/scraping, don't reset — give progress update instead ──
    if (state === 'generating' || state === 'scraping') {
      let progressMsg = '';

      if (state === 'scraping') {
        const scrapeMsgs = [
          'Still pulling the listing data — give me a moment.',
          'Almost there — just finishing up the property preview.',
          'Working on it — analysing the listing photos now.',
        ];
        progressMsg = scrapeMsgs[Math.floor(Math.random() * scrapeMsgs.length)];
      } else if (conv?.input_data) {
        // Check actual progress from DB
        try {
          const cleanUrl = conv.input_data.replace(/[?#].*$/, '').replace(/\/+$/, '');
          const { rows: prop } = await pool.query('SELECT id FROM properties WHERE listing_url ILIKE $1 ORDER BY id DESC LIMIT 1', [`%${cleanUrl}%`]);
          if (prop.length > 0) {
            const { rows: imgCheck } = await pool.query(
              'SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE vision_analysis IS NOT NULL) AS done FROM property_images WHERE property_id = $1',
              [prop[0].id]
            );
            const total = parseInt(imgCheck[0].total);
            const done = parseInt(imgCheck[0].done);
            const elapsed = Math.round((Date.now() - new Date(conv.updated_at).getTime()) / 60000);

            if (done > 0 && done >= total) {
              progressMsg = 'Almost done — just compiling the final report now.';
            } else if (done > 0) {
              const msgs = [
                `Still working — checked ${done} of ${total} photos so far.`,
                `Making progress — ${done}/${total} photos analysed. Hang tight.`,
                `${done} out of ${total} photos done — won't be long now.`,
              ];
              progressMsg = msgs[Math.floor(Math.random() * msgs.length)];
            } else if (total > 0) {
              const msgs = [
                `Found ${total} photos — running the analysis now.`,
                `Got ${total} listing photos to check. This is the thorough part.`,
                `Working through ${total} photos — this takes a few minutes but it's worth it.`,
              ];
              progressMsg = msgs[Math.floor(Math.random() * msgs.length)];
            } else {
              const msgs = [
                'Still collecting property data — photos, location, risk factors.',
                `Report has been running for about ${elapsed || 1} minute${elapsed !== 1 ? 's' : ''} — still going.`,
                'Pulling data from multiple sources — crime stats, infrastructure, compliance.',
              ];
              progressMsg = msgs[Math.floor(Math.random() * msgs.length)];
            }
          } else {
            progressMsg = 'Your report is being generated — still setting up the property profile.';
          }
        } catch {
          progressMsg = 'Still working on your report — I\'ll send it as soon as it\'s ready.';
        }
      } else {
        progressMsg = 'Still working on your report — I\'ll send it as soon as it\'s ready.';
      }

      await sendWhatsApp(from, progressMsg);
      res.type('text/xml').send('<Response></Response>');
      return;
    }

    // ── GLOBAL: Reset commands work from awaiting/tease states only ──
    const isReset = ['start again', 'reset', 'new', 'new property', 'start over', 'restart', 'cancel', 'menu', 'hi', 'hello', 'hey'].includes(normalised);

    if (isReset && state !== 'awaiting_property' && state !== 'report_ready') {
      await upsertConversation(phoneNumber, { state: 'awaiting_property' });
      await sendWhatsApp(from,
        "No problem — let's start fresh.\n\nSend me a PrivateProperty or Property24 listing link and I'll give you a quick risk preview before you decide on the full report."
      );
      res.type('text/xml').send('<Response></Response>');
      return;
    }

    // ── GLOBAL: Listing URL sent from ANY state → start new analysis ──
    if (hasListingURL && state !== 'scraping') {
      await sendWhatsApp(from, 'Got it — checking this property now. ⏳');
      // Clear old tease_data when a new URL is submitted
      const isNewUrl = !conv || conv.listing_url !== url;
      await upsertConversation(phoneNumber, {
        state: 'scraping',
        input_data: url,
        listing_url: url,
        ...(isNewUrl ? { tease_data: null } : {}),
      });
      runTeaseAsync(from, phoneNumber, url);
      res.type('text/xml').send('<Response></Response>');
      return;
    }

    // ── STATE-SPECIFIC HANDLING ─────────────────────────────────
    switch (state) {

      case 'awaiting_property': {
        await upsertConversation(phoneNumber, { state: 'awaiting_property' });
        await sendWhatsApp(from,
          "Welcome to Surepath 👋\n\nI check properties for hidden risks before you buy.\n\nPaste a PrivateProperty or Property24 listing link and I'll pull the photos, analyse them for defects, and give you a quick preview — free.\n\nThe full report includes deeds history, crime stats, infrastructure risks, and repair cost estimates — R149."
        );
        break;
      }

      case 'scraping': {
        await sendWhatsApp(from, 'Still pulling this one — almost done. 🔍');
        break;
      }

      case 'tease_sent': {
        if (['yes', 'ja', '1', 'buy', 'full report', 'yes please', 'yep', 'sure', 'ok', 'okay', 'do it', 'go ahead', 'lets go', "let's go"].includes(normalised)) {
          const REPORT_PRICE = 149;
          const PAYMENT_ENABLED = !!(PAYFAST_MERCHANT_ID && PAYFAST_MERCHANT_KEY && process.env.PAYMENT_ENABLED === 'true');

          if (PAYMENT_ENABLED) {
            // Create order and send payment link
            try {
              const { rows: orderRows } = await pool.query(
                'INSERT INTO orders (phone_number, price_zar, payment_status) VALUES ($1, $2, $3) RETURNING id',
                [phoneNumber, REPORT_PRICE, 'pending']
              );
              const orderId = orderRows[0].id;
              const payUrl = generatePayFastURL(orderId, REPORT_PRICE);

              await upsertConversation(phoneNumber, {
                state: 'payment_pending',
                asking_price: conv.asking_price || null,
              });

              await sendWhatsApp(from, [
                `The full Surepath report for this property is *R${REPORT_PRICE}*.`,
                '',
                'It includes:',
                '• Deeds history & ownership',
                '• Crime statistics for the area',
                '• All photo risk analysis findings',
                '• Repair cost estimates',
                '• Infrastructure & compliance data',
                '• Security & community intelligence',
                '• Purchase decision recommendation',
                '',
                `Pay securely here: ${payUrl}`,
                '',
                'Once payment is confirmed, your report will be generated and sent here automatically.',
              ].join('\n'));
            } catch (err) {
              console.error(`[payfast] Order creation failed: ${err.message}`);
              await sendWhatsApp(from, 'Something went wrong setting up the payment. Please try again or contact us.');
            }
          } else {
            // Payment disabled — generate report directly (dev/test mode)
            await sendWhatsApp(from, "Generating your full report now — I'll send it as soon as it's ready. ⏳");

            await upsertConversation(phoneNumber, {
              state: 'generating',
              asking_price: conv.asking_price || null,
            });

            runPipelineAsync({ phone_number: phoneNumber }, conv);
          }

        } else {
          await sendWhatsApp(from, `Reply *1* for the full report (R149), or paste a new listing link to check a different property.`);
        }
        break;
      }

      case 'payment_pending': {
        if (hasListingURL) break; // handled by the global URL handler above
        await sendWhatsApp(from,
          "I'm waiting for your payment to come through. Once it's confirmed, your report will be generated automatically.\n\nIf you've already paid, give it a minute — PayFast sometimes takes a moment to confirm.\n\nTo check a different property, send a new listing link."
        );
        break;
      }

      case 'generating':
      case 'scraping': {
        // Handled above before the switch — this is a fallback
        await sendWhatsApp(from, "Still working on your report — I'll send it as soon as it's ready.");
        break;
      }

      case 'report_ready': {
        // Resend the report if they ask
        if (['1', 'resend', 'send again', 'report', 'pdf', 'send report', 'send pdf', 'again'].includes(normalised)) {
          try {
            const cleanUrl = (conv.input_data || '').replace(/[?#].*$/, '').replace(/\/+$/, '');
            const { rows: prop } = await pool.query('SELECT id FROM properties WHERE listing_url ILIKE $1 ORDER BY id DESC LIMIT 1', [`%${cleanUrl}%`]);
            if (prop.length > 0) {
              await sendWhatsApp(from, 'Generating your report PDF now...');
              const { exportInspectPagePDF } = require('./pdf');
              const pdfResult = await exportInspectPagePDF(prop[0].id, conv.asking_price, { source: 'whatsapp', phoneNumber });
              let pdfUrl = pdfResult.pdfUrl;
              if (pdfUrl && pdfUrl.startsWith('/reports/')) {
                const serverHost = process.env.SERVER_HOST || 'localhost:3000';
                const proto = serverHost.includes('ngrok') || serverHost.includes('surepath.co.za') ? 'https' : 'http';
                pdfUrl = `${proto}://${serverHost}${pdfUrl}`;
              }
              if (pdfUrl) {
                try {
                  await sendWhatsApp(from, '*Your Surepath Report*\n\nIf you have questions, reply here. To check another property, send a new listing link.', pdfUrl);
                } catch {
                  await new Promise(r => setTimeout(r, 5000));
                  try {
                    await sendWhatsApp(from, '*Your Surepath Report*', pdfUrl);
                  } catch {
                    await sendWhatsApp(from, `Download your report: ${pdfUrl}`);
                  }
                }
              }
            } else {
              await sendWhatsApp(from, "I can't find that property — send the listing link again and I'll generate a fresh report.");
              await upsertConversation(phoneNumber, { state: 'awaiting_property' });
            }
          } catch (err) {
            console.error(`[resend] Error: ${err.message}`);
            await sendWhatsApp(from, 'Something went wrong resending the report. Send the listing link again to try from scratch.');
            await upsertConversation(phoneNumber, { state: 'awaiting_property' });
          }
        } else {
          await sendWhatsApp(from,
            "Your report was sent above. Reply *1* to resend it, or send a new listing link to check another property."
          );
        }
        break;
      }

      default: {
        await upsertConversation(phoneNumber, { state: 'awaiting_property' });
        await sendWhatsApp(from,
          "Welcome to Surepath 👋\n\nPaste a PrivateProperty or Property24 listing link and I'll give you a free risk preview."
        );
      }
    }

    res.type('text/xml').send('<Response></Response>');

  } catch (err) {
    console.error(`[whatsapp] Error handling message from ${phoneNumber}:`, err);
    res.type('text/xml').send('<Response></Response>');
  }
});

// ─── PayFast ITN webhook (POST /webhook/payfast) ──────────────────────

function validatePayFastSignature(data, passphrase) {
  const params = { ...data };
  delete params.signature;

  let paramString = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v).trim())}`)
    .join('&');

  if (passphrase) {
    paramString += `&passphrase=${encodeURIComponent(passphrase.trim())}`;
  }

  const expectedSig = crypto.createHash('md5').update(paramString).digest('hex');
  return expectedSig === data.signature;
}

router.post('/webhook/payfast', express.urlencoded({ extended: false }), async (req, res) => {
  const data = req.body;

  console.log(`[payfast] ITN received: m_payment_id=${data.m_payment_id}, status=${data.payment_status}`);

  // Return 200 immediately (PayFast requires response within 30s)
  res.sendStatus(200);

  try {
    if (!validatePayFastSignature(data, process.env.PAYFAST_PASSPHRASE || '')) {
      console.error('[payfast] Invalid signature — ignoring');
      return;
    }

    if (data.payment_status !== 'COMPLETE') {
      console.log(`[payfast] Payment not complete: ${data.payment_status}`);
      return;
    }

    const orderId = parseInt(data.m_payment_id);
    if (isNaN(orderId)) {
      console.error('[payfast] Invalid m_payment_id');
      return;
    }

    const { rows: orders } = await pool.query(
      'SELECT * FROM orders WHERE id = $1',
      [orderId]
    );

    if (orders.length === 0) {
      console.error(`[payfast] Order ${orderId} not found`);
      return;
    }

    const order = orders[0];

    await pool.query(
      `UPDATE orders SET payment_status = 'paid', payfast_payment_id = $1 WHERE id = $2`,
      [data.pf_payment_id, orderId]
    );

    console.log(`[payfast] Order ${orderId} marked as paid`);

    const conv = await getConversation(order.phone_number);
    if (!conv) {
      console.error(`[payfast] No conversation found for ${order.phone_number}`);
      return;
    }

    runPipelineAsync(order, conv);

  } catch (err) {
    console.error('[payfast] Error processing ITN:', err);
  }
});

/**
 * Run the report pipeline in the background.
 * The pipeline creates the property, runs all processes, creates the order, and renders the PDF.
 *
 * @param {{ phone_number: string, payment_status?: string, id?: number }} order
 * @param {object} conv - conversation state with input_data and asking_price
 */
async function runPipelineAsync(order, conv) {
  const phoneNumber = order.phone_number;

  try {
    // Only send "payment received" if this was a real payment
    if (order.payment_status === 'paid') {
      await sendWhatsApp(phoneNumber,
        'Payment received! Generating your Surepath report now. This takes about 10-15 minutes.'
      );
    }

    const input = conv.input_data;
    const askingPrice = conv.asking_price;

    console.log(`[pipeline] Starting for ${phoneNumber}: "${input}", R${askingPrice}`);

    // Check if property already has COMPLETE data — only skip pipeline if everything is done
    let propertyId = null;
    if (input && input.startsWith('http')) {
      const cleanInput = input.replace(/[?#].*$/, '').replace(/\/+$/, '');
      const { rows: existing } = await pool.query(
        'SELECT id, lat, suburb FROM properties WHERE listing_url ILIKE $1 ORDER BY id DESC LIMIT 1',
        [`%${cleanInput}%`]
      );
      if (existing.length > 0) {
        const pid = existing[0].id;
        const hasCoords = !!existing[0].lat;
        const hasSuburb = !!existing[0].suburb;

        // Check completeness: ALL photos analysed + streetview + satellite
        const { rows: imgCheck } = await pool.query(`
          SELECT
            COUNT(*) FILTER (WHERE source NOT IN ('streetview','satellite')) AS total_photos,
            COUNT(*) FILTER (WHERE source NOT IN ('streetview','satellite') AND vision_analysis IS NOT NULL) AS analysed_photos,
            COUNT(*) FILTER (WHERE source = 'streetview' AND vision_analysis IS NOT NULL) AS sv_analysed,
            COUNT(*) FILTER (WHERE source = 'satellite' AND vision_analysis IS NOT NULL) AS sat_analysed
          FROM property_images WHERE property_id = $1
        `, [pid]);

        const totalPhotos = parseInt(imgCheck[0].total_photos);
        const analysedPhotos = parseInt(imgCheck[0].analysed_photos);
        const svAnalysed = parseInt(imgCheck[0].sv_analysed) > 0;
        const satAnalysed = parseInt(imgCheck[0].sat_analysed) > 0;
        const allAnalysed = totalPhotos > 0 && analysedPhotos >= totalPhotos;

        const isComplete = hasCoords && hasSuburb && allAnalysed && svAnalysed && satAnalysed;

        if (isComplete) {
          propertyId = pid;
          console.log(`[pipeline] Property ${pid} fully complete (${analysedPhotos}/${totalPhotos} photos, sv+sat analysed) — exporting PDF directly`);
        } else {
          console.log(`[pipeline] Property ${pid} incomplete — coords:${hasCoords} suburb:${hasSuburb} sv:${svAnalysed} sat:${satAnalysed} photos:${analysedPhotos}/${totalPhotos} — running pipeline`);
        }
      }
    }

    if (!propertyId) {
      // Full pipeline — collect all data
      const result = await generateReport(input, askingPrice, phoneNumber);
      propertyId = result.property_id;

      if (order.id) {
        await pool.query(
          'UPDATE orders SET report_id = $1, report_delivered_at = NOW() WHERE id = $2',
          [result.report_id, order.id]
        );
      }
    }

    // Export the inspect page as a fresh PDF
    await sendWhatsApp(phoneNumber, 'Generating your PDF report now...').catch(() => {});

    const { exportInspectPagePDF } = require('./pdf');
    const pdfResult = await exportInspectPagePDF(propertyId, askingPrice, { source: 'whatsapp', phoneNumber });

    await upsertConversation(phoneNumber, { state: 'report_ready' });

    // Make PDF URL publicly accessible for Twilio to fetch
    let publicPdfUrl = pdfResult.pdfUrl;
    if (publicPdfUrl && publicPdfUrl.startsWith('/reports/')) {
      const serverHost = process.env.SERVER_HOST || 'localhost:3000';
      const proto = serverHost.includes('ngrok') || serverHost.includes('surepath.co.za') ? 'https' : 'http';
      publicPdfUrl = `${proto}://${serverHost}${publicPdfUrl}`;
    }

    const reportMsg = `*Your Surepath Report is Ready*\n\n` +
      `We've checked the listing photos, Street View, satellite imagery, deeds history, crime stats, infrastructure risks, and compliance requirements.\n\n` +
      `If you have questions about what we found, reply here.\n\nTo check another property, send me a new listing link.`;

    if (publicPdfUrl) {
      console.log(`[pipeline] Sending PDF: ${publicPdfUrl}`);
      try {
        await sendWhatsApp(phoneNumber, reportMsg, publicPdfUrl);
        console.log(`[pipeline] Report delivered to ${phoneNumber}`);
      } catch (sendErr) {
        console.error(`[pipeline] PDF send failed: ${sendErr.message} — retrying in 5s`);
        await new Promise(r => setTimeout(r, 5000));
        try {
          await sendWhatsApp(phoneNumber, reportMsg, publicPdfUrl);
          console.log(`[pipeline] Report delivered on retry to ${phoneNumber}`);
        } catch (retryErr) {
          console.error(`[pipeline] PDF retry failed: ${retryErr.message} — sending as link`);
          await sendWhatsApp(phoneNumber, reportMsg + `\n\nDownload your report:\n${publicPdfUrl}`);
        }
      }
    } else {
      await sendWhatsApp(phoneNumber, reportMsg);
    }

  } catch (err) {
    console.error(`[pipeline] Failed for ${phoneNumber}:`, err);

    // Check if the report was actually generated despite the error
    const cleanUrl = (conv?.input_data || '').replace(/[?#].*$/, '').replace(/\/+$/, '');
    const { rows: checkReport } = await pool.query(
      "SELECT pr.pdf_url FROM property_reports pr JOIN properties p ON p.id = pr.property_id WHERE p.listing_url ILIKE $1 AND pr.status = 'complete' AND pr.pdf_url IS NOT NULL ORDER BY pr.created_at DESC LIMIT 1",
      [`%${cleanUrl}%`]
    ).catch(() => ({ rows: [] }));

    if (checkReport.length > 0 && checkReport[0].pdf_url) {
      let rescueUrl = checkReport[0].pdf_url;
      if (rescueUrl.startsWith('/reports/')) {
        const serverHost = process.env.SERVER_HOST || 'localhost:3000';
        const proto = serverHost.includes('ngrok') || serverHost.includes('surepath.co.za') ? 'https' : 'http';
        rescueUrl = `${proto}://${serverHost}${rescueUrl}`;
      }
      await sendWhatsApp(phoneNumber,
        `*Your Surepath Report is Ready*\n\nDownload your report: ${rescueUrl}\n\nIf you have questions, reply here. To check another property, send a new listing link.`
      );
    } else {
      await sendWhatsApp(phoneNumber,
        'Something went wrong generating your report. Our team has been notified and will sort this out within the hour. Sorry about that.'
      );
    }
  }
}

module.exports = router;
