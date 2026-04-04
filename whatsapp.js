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
router.use('/reports', express.static(reportPath));

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
          'Reply *1* to get the full report (R149) or *2* to pass on this one.',
        ].join('\n');

        await sendWhatsApp(from, message);
        return;
      }
    }

    // ── CHECK: Property exists in DB — generate tease from stored findings ──
    const { rows: existingProps } = await pool.query(
      'SELECT id, address_raw, address_normalised, asking_price, bedrooms, bathrooms FROM properties WHERE listing_url = $1 ORDER BY id DESC LIMIT 1',
      [url]
    );

    if (existingProps.length > 0) {
      const p = existingProps[0];
      const propertyId = p.id;
      console.log(`[tease] Found existing property ${propertyId} for URL — generating tease from stored findings`);

      // Gather top risk flags from stored vision analysis
      const { rows: imgFindings } = await pool.query(
        "SELECT vision_analysis FROM property_images WHERE property_id = $1 AND vision_analysis IS NOT NULL LIMIT 6",
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
        : 'none found in photos';

      let nicoTease;
      try {
        const Anthropic = require('@anthropic-ai/sdk');
        const client = new Anthropic();
        const resp = await client.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 150,
          system: "You are Nico, a South African ex-property agent, aged 38-42. You are calm, direct, and slightly contrarian. You've seen a lot of properties and you don't sugarcoat things. Write exactly 2 sentences about this property for a potential buyer. The reader is considering buying. Be honest but not alarmist. Do not mention AI. Do not use estate agent language. Do not say 'however' or 'that said'. Write in plain conversational South African English. Do not invent problems that aren't in the risk flags — only reference what was actually observed. Do not speculate about hidden issues or rooms not photographed. If there are no risk flags, mention what looks good and recommend the full report for a complete picture.",
          messages: [{ role: 'user', content: `Property: ${address}. Asking price: R${p.asking_price ? Number(p.asking_price).toLocaleString('en-ZA') : 'unknown'}. Top risk flags from photo analysis: ${flagsText}.` }],
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
        'Reply *1* to get the full report (R149) or *2* to pass on this one.',
      ].join('\n');

      await sendWhatsApp(from, message);
      return;
    }

    // ── No existing property — scrape and generate fresh tease ──
    let extractedData;
    if (isP24) {
      const html = await fetchHTML(url);
      const p24 = extractProperty24Data(html);
      const bodyText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      const priceMatch = bodyText.match(/R\s*([\d\s,]+)/);
      let price = null;
      if (priceMatch) { const p = parseInt(priceMatch[1].replace(/[\s,]/g, '')); if (p >= 50000) price = p; }
      const bedsMatch = bodyText.match(/(\d+)\s*Bed/i);
      const bathsMatch = bodyText.match(/(\d+)\s*Bath/i);
      extractedData = {
        address: p24.address,
        askingPrice: price,
        bedrooms: bedsMatch ? parseInt(bedsMatch[1]) : null,
        bathrooms: bathsMatch ? parseInt(bathsMatch[1]) : null,
        photoUrls: p24.photoUrls,
        description: null,
        listingId: null,
      };
    } else {
      extractedData = await extractPrivatePropertyData(url);
    }

    if (!extractedData || !extractedData.address) {
      throw new Error('Could not extract listing data');
    }

    // Create property record immediately so it appears in the system
    try {
      // Extract suburb/city from URL
      const urlParts = url.replace(/.*\/for-sale\//, '').split('/');
      let urlSuburb = null, urlCity = null, urlProvince = null;
      if (isPP && urlParts.length >= 5) {
        urlProvince = urlParts[0].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        urlCity = urlParts[2].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        urlSuburb = urlParts[3].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      } else if (isP24 && urlParts.length >= 3) {
        urlSuburb = urlParts[0].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        urlCity = urlParts[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        urlProvince = urlParts[2].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      }

      const ppMatch = url.match(/(T\d+)/);
      const p24Match = url.match(/\/(\d{6,})(?:\/|$)/);
      const erfNumber = ppMatch ? `PP_${ppMatch[1]}` : p24Match ? `P24_${p24Match[1]}` : `WA_${Date.now()}`;

      await pool.query(
        `INSERT INTO properties (erf_number, address_raw, listing_url, asking_price, bedrooms, bathrooms, suburb, city, province)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (erf_number) DO UPDATE SET
           listing_url = COALESCE(EXCLUDED.listing_url, properties.listing_url),
           asking_price = COALESCE(EXCLUDED.asking_price, properties.asking_price),
           bedrooms = COALESCE(EXCLUDED.bedrooms, properties.bedrooms),
           bathrooms = COALESCE(EXCLUDED.bathrooms, properties.bathrooms),
           suburb = COALESCE(EXCLUDED.suburb, properties.suburb),
           city = COALESCE(EXCLUDED.city, properties.city),
           province = COALESCE(EXCLUDED.province, properties.province)`,
        [erfNumber, extractedData.address, url, extractedData.askingPrice || null,
         extractedData.bedrooms || null, extractedData.bathrooms || null,
         urlSuburb, urlCity, urlProvince]
      );

      // Store photos
      if (extractedData.photoUrls?.length > 0) {
        const source = isPP ? 'privateproperty' : 'property24';
        for (const photoUrl of extractedData.photoUrls) {
          await pool.query(
            `INSERT INTO property_images (property_id, source, image_url, image_type)
             SELECT id, $2, $3, 'listing' FROM properties WHERE erf_number = $1
             ON CONFLICT DO NOTHING`,
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

    // Store tease in conversation
    await upsertConversation(phoneNumber, {
      state: 'tease_sent',
      tease_data: JSON.stringify(tease),
      asking_price: tease.askingPrice || null,
      pp_listing_id: extractedData.listingId || null,
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

    // ── GLOBAL: Reset commands work from ANY state ──────────────
    const isReset = ['start again', 'reset', 'new', 'new property', 'start over', 'restart', 'cancel', 'menu', 'hi', 'hello', 'hey'].includes(normalised);

    if (isReset && state !== 'awaiting_property') {
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
          // Reply immediately — don't make them wait
          await sendWhatsApp(from, "Generating your full report now — I'll send it as soon as it's ready. ⏳");

          await upsertConversation(phoneNumber, {
            state: 'generating',
            asking_price: conv.asking_price || null,
          });

          // Pipeline creates the property, runs all processes, and exports the PDF
          runPipelineAsync({ phone_number: phoneNumber }, conv);

        } else {
          await sendWhatsApp(from, `Reply *1* for the full report, or paste a new listing link to check a different property.`);
        }
        break;
      }

      case 'generating':
      case 'payment_pending': {
        await sendWhatsApp(from,
          "Your report is being generated — I'll send it as soon as it's ready. Usually 10-15 minutes.\n\nIn the meantime, you can paste another listing link and I'll queue a preview on that one too."
        );
        // If they sent a new URL, the global handler above already caught it
        break;
      }

      case 'report_ready': {
        await sendWhatsApp(from,
          "Your report was delivered above ☝️\n\nGot questions about what I found? Ask away — or send me a new listing link to check another property."
        );
        await upsertConversation(phoneNumber, { state: 'awaiting_property' });
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

    // Check if property already exists with data — skip pipeline if so
    let propertyId = null;
    if (input && input.startsWith('http')) {
      const cleanInput = input.replace(/[?#].*$/, '').replace(/\/+$/, '');
      const { rows: existing } = await pool.query(
        'SELECT id FROM properties WHERE listing_url ILIKE $1 ORDER BY id DESC LIMIT 1',
        [`%${cleanInput}%`]
      );
      if (existing.length > 0) {
        // Check if it has vision analysis (meaning data collection is complete)
        const { rows: imgCheck } = await pool.query(
          'SELECT COUNT(*) AS c FROM property_images WHERE property_id = $1 AND vision_analysis IS NOT NULL',
          [existing[0].id]
        );
        if (parseInt(imgCheck[0].c) > 0) {
          propertyId = existing[0].id;
          console.log(`[pipeline] Property ${propertyId} already has data — skipping pipeline, exporting PDF directly`);
        }
      }
    }

    if (!propertyId) {
      // Full pipeline — collect all data, with progress updates
      await sendWhatsApp(phoneNumber, '1/4 — Collecting property data and photos...').catch(() => {});

      const result = await generateReport(input, askingPrice, phoneNumber);
      propertyId = result.property_id;

      // If this was triggered by PayFast, update the original order
      if (order.id) {
        await pool.query(
          'UPDATE orders SET report_id = $1, report_delivered_at = NOW() WHERE id = $2',
          [result.report_id, order.id]
        );
      }

      await sendWhatsApp(phoneNumber, '3/4 — Data collection complete. Generating your PDF report...').catch(() => {});
    } else {
      await sendWhatsApp(phoneNumber, 'Property data already on file — generating your PDF report...').catch(() => {});
    }

    await upsertConversation(phoneNumber, { state: 'report_ready' });

    // Export the inspect page as a fresh PDF (always current data)
    console.log(`[pipeline] Exporting inspect page PDF for property ${propertyId}...`);

    const { exportInspectPagePDF } = require('./pdf');
    const pdfResult = await exportInspectPagePDF(propertyId, askingPrice);

    // Update report with PDF URL
    if (pdfResult.pdfUrl && pdfResult.reportId) {
      await pool.query('UPDATE property_reports SET pdf_url = $1 WHERE id = $2', [pdfResult.pdfUrl, pdfResult.reportId]);
    }

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
      await sendWhatsApp(phoneNumber, reportMsg, publicPdfUrl);
    } else {
      console.log(`[pipeline] No PDF — sending message only`);
      await sendWhatsApp(phoneNumber, reportMsg);
    }

    console.log(`[pipeline] Report ${result.report_id} delivered to ${phoneNumber}`);

  } catch (err) {
    console.error(`[pipeline] Failed for ${phoneNumber}:`, err);

    await sendWhatsApp(phoneNumber,
      'Something went wrong generating your report. Our team has been notified and will sort this out within the hour. Sorry about that.'
    );
  }
}

module.exports = router;
