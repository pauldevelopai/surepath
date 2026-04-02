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

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER;
const PAYFAST_MERCHANT_ID = process.env.PAYFAST_MERCHANT_ID;
const PAYFAST_MERCHANT_KEY = process.env.PAYFAST_MERCHANT_KEY;

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ─── Helpers ───────────────────────────────────────────────────────────

function sendWhatsApp(to, body, mediaUrl) {
  const msg = {
    from: `whatsapp:${TWILIO_WHATSAPP_NUMBER}`,
    to: to.startsWith('whatsapp:') ? to : `whatsapp:${to}`,
    body,
  };
  if (mediaUrl) msg.mediaUrl = [mediaUrl];
  return twilioClient.messages.create(msg);
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

    let extractedData;
    if (isP24) {
      const html = await fetchHTML(url);
      const p24 = extractProperty24Data(html);
      extractedData = {
        address: p24.address,
        askingPrice: null,
        bedrooms: null,
        bathrooms: null,
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

    let riskLines = '';
    if (tease.topRiskFlags.length > 0) {
      riskLines = tease.topRiskFlags.map(f => `⚠️ ${f}`).join('\n');
    } else {
      riskLines = '✅ First photos look clean — full report will cover all rooms and exterior.';
    }

    const message = [
      `*${tease.address}*`,
      bedsLine ? `${bedsLine} · Asking ${priceFormatted}` : `Asking ${priceFormatted}`,
      '',
      tease.nicoTease,
      '',
      riskLines,
      '',
      'The full Surepath report includes deeds history, comparable sales, all risk flags, repair cost estimates, and a clear buy/negotiate/walk away verdict.',
      '',
      'Reply *1* to get the full report (R149) or *2* to pass on this one.',
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

  try {
    const conv = await getConversation(phoneNumber);
    const state = conv ? conv.state : 'awaiting_property';

    switch (state) {

      // ── AWAITING PROPERTY ───────────────────────────────────────
      case 'awaiting_property': {
        const url = extractURL(body);

        if (url && (isProperty24URL(url) || isPrivatePropertyURL(url))) {
          await sendWhatsApp(from, 'On it — pulling the listing now. Give me 30 seconds. ⏳');
          await upsertConversation(phoneNumber, {
            state: 'scraping',
            input_data: url,
            listing_url: url,
          });
          // Fire and forget — do NOT await
          runTeaseAsync(from, phoneNumber, url);
        } else {
          await upsertConversation(phoneNumber, { state: 'awaiting_property' });
          await sendWhatsApp(from,
            "Welcome to Surepath 👋\n\nSend me a PrivateProperty or Property24 listing link and I'll show you what to watch out for before you decide whether to buy the full report."
          );
        }
        break;
      }

      // ── SCRAPING (tease in progress) ────────────────────────────
      case 'scraping': {
        await sendWhatsApp(from, 'Still pulling this one — almost done. 🔍');
        break;
      }

      // ── TEASE SENT — awaiting buy decision ──────────────────────
      case 'tease_sent': {
        const normalised = body.toLowerCase().trim();

        if (['yes', 'ja', '1', 'buy', 'full report', 'yes please', 'yep', 'sure', 'ok', 'okay'].includes(normalised)) {
          // TEST MODE: skip payment, go straight to report generation
          const erfNumber = `PP_WA_${phoneNumber}_${Date.now()}`;
          const { rows: propRows } = await pool.query(
            `INSERT INTO properties (erf_number, address_raw)
             VALUES ($1, $2)
             ON CONFLICT (erf_number) DO UPDATE SET address_raw = EXCLUDED.address_raw
             RETURNING id`,
            [erfNumber, conv.input_data || 'WhatsApp listing']
          );
          const propertyId = propRows[0].id;

          const { rows: orderRows } = await pool.query(
            `INSERT INTO orders (property_id, phone_number, price_zar, payment_status)
             VALUES ($1, $2, 0, 'test_bypass')
             RETURNING id`,
            [propertyId, phoneNumber]
          );
          const orderId = orderRows[0].id;

          await upsertConversation(phoneNumber, {
            state: 'payment_pending',
            order_id: orderId,
            asking_price: conv.asking_price || null,
          });

          await sendWhatsApp(from, 'Generating your full report now — this takes about 10 minutes. ⏳');

          // Run pipeline directly (no payment needed in test mode)
          const order = { id: orderId, phone_number: phoneNumber, property_id: propertyId };
          runPipelineAsync(order, conv);

        } else if (['no', 'nee', '2', 'no thanks', 'nope', 'skip', 'not now'].includes(normalised)) {
          await upsertConversation(phoneNumber, { state: 'awaiting_property' });
          await sendWhatsApp(from, 'No problem. Send me another listing whenever you\'re ready.');

        } else {
          await sendWhatsApp(from, 'Reply *1* to get the full report (R149) or *2* to pass on this one.');
        }
        break;
      }

      // ── PAYMENT PENDING ─────────────────────────────────────────
      case 'payment_pending': {
        await sendWhatsApp(from,
          'Waiting for payment confirmation — once it clears your report will be on its way. Usually a minute or two. ⏳'
        );
        break;
      }

      // ── REPORT READY ────────────────────────────────────────────
      case 'report_ready': {
        await sendWhatsApp(from,
          "Your report was already delivered. Got questions about what we found? Reply here.\n\nTo check another property, just send me a new listing link."
        );
        await upsertConversation(phoneNumber, { state: 'awaiting_property' });
        break;
      }

      default: {
        await upsertConversation(phoneNumber, { state: 'awaiting_property' });
        await sendWhatsApp(from,
          "Welcome to Surepath 👋\n\nSend me a PrivateProperty or Property24 listing link and I'll show you what to watch out for before you decide whether to buy the full report."
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
 * Run the report pipeline in the background after payment confirmation.
 */
async function runPipelineAsync(order, conv) {
  const phoneNumber = order.phone_number;

  try {
    await sendWhatsApp(phoneNumber,
      'Payment received! Generating your Surepath report now. This takes about 10-15 minutes.'
    );

    const input = conv.input_data;
    const askingPrice = conv.asking_price;

    console.log(`[pipeline] Starting for order ${order.id}: "${input}", R${askingPrice}`);

    const result = await generateReport(input, askingPrice, phoneNumber);

    await pool.query(
      `UPDATE orders SET report_id = $1, report_delivered_at = NOW() WHERE id = $2`,
      [result.report_id, order.id]
    );

    await upsertConversation(phoneNumber, { state: 'report_ready' });

    if (result.pdf_url) {
      await sendWhatsApp(phoneNumber,
        `Your Surepath report is attached.\n\n` +
        `Decision: *${result.decision}*\n` +
        `${result.decision_reasoning}\n\n` +
        `If you have questions about what we found, reply here.`,
        result.pdf_url
      );
    } else {
      await sendWhatsApp(phoneNumber,
        `Your Surepath report is ready.\n\n` +
        `Decision: *${result.decision}*\n` +
        `${result.decision_reasoning}\n\n` +
        `If you have questions about what we found, reply here.`
      );
    }

    console.log(`[pipeline] Report ${result.report_id} delivered to ${phoneNumber}`);

  } catch (err) {
    console.error(`[pipeline] Failed for order ${order.id}:`, err);

    await sendWhatsApp(phoneNumber,
      'Something went wrong generating your report. Our team has been notified and will sort this out within the hour. Sorry about that.'
    );
  }
}

module.exports = router;
