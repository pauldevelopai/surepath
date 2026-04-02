const express = require('express');
const crypto = require('crypto');
const twilio = require('twilio');
const pool = require('./db');
const { generateReport } = require('./pipeline');

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

function containsAddress(text) {
  // SA address heuristic: number + street name + suburb/city
  return /\d+\s+\w+\s+(street|st|road|rd|ave|avenue|drive|dr|crescent|cr|lane|ln|way|close|cl)/i.test(text);
}

function parsePrice(text) {
  // Handle: R2500000, R2 500 000, 2500000, R2,500,000, 2.5m, R2.5m
  const cleaned = text.replace(/\s/g, '').toUpperCase();

  // Check for millions shorthand: 2.5m, R2.5M
  const millionMatch = cleaned.match(/R?(\d+\.?\d*)M/);
  if (millionMatch) return Math.round(parseFloat(millionMatch[1]) * 1_000_000);

  // Strip R and separators
  const numStr = cleaned.replace(/^R/, '').replace(/[,.\s]/g, '');
  const num = parseInt(numStr);
  return isNaN(num) ? null : num;
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

  // PayFast signature: MD5 of URL-encoded params in order (excl. passphrase for sandbox)
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

// ─── WhatsApp webhook (POST /webhook/whatsapp) ────────────────────────

router.post('/webhook/whatsapp', express.urlencoded({ extended: false }), async (req, res) => {
  const from = req.body.From;           // whatsapp:+27821234567
  const body = (req.body.Body || '').trim();
  const numMedia = parseInt(req.body.NumMedia || '0');
  const phoneNumber = from.replace('whatsapp:', '');

  console.log(`[whatsapp] ${phoneNumber}: "${body}" (${numMedia} media)`);

  try {
    let conv = await getConversation(phoneNumber);
    const state = conv ? conv.state : 'awaiting_property';

    switch (state) {

      // ── AWAITING PROPERTY ───────────────────────────────────────
      case 'awaiting_property': {
        const url = extractURL(body);
        const isAddress = containsAddress(body);

        if (url || isAddress) {
          const inputData = url || body;
          await upsertConversation(phoneNumber, {
            state: 'awaiting_photos',
            input_data: inputData,
          });

          const display = url ? 'that Property24 listing' : body;
          await sendWhatsApp(from,
            `Got it — ${display}. Send me the Property24 link and I'll pull the photos automatically, or forward me the listing photos directly. Which is easier?`
          );
        } else {
          await upsertConversation(phoneNumber, { state: 'awaiting_property' });
          await sendWhatsApp(from,
            `Welcome to Surepath. Send me the Property24 link or the address of the property you're looking at.`
          );
        }
        break;
      }

      // ── AWAITING PHOTOS ─────────────────────────────────────────
      case 'awaiting_photos': {
        const url = extractURL(body);

        if (url) {
          // Property24 link — pipeline will scrape photos
          await upsertConversation(phoneNumber, {
            state: 'awaiting_asking_price',
            input_data: url,
          });
          await sendWhatsApp(from,
            `What's the asking price on this one? (e.g. R2 500 000)`
          );
        } else if (numMedia > 0) {
          // User sent photos directly
          const mediaUrls = [];
          for (let i = 0; i < numMedia; i++) {
            const mediaUrl = req.body[`MediaUrl${i}`];
            if (mediaUrl) mediaUrls.push(mediaUrl);
          }

          const existing = conv?.photo_urls || [];
          const allPhotos = [...existing, ...mediaUrls];

          await upsertConversation(phoneNumber, {
            state: 'awaiting_asking_price',
            photo_urls: allPhotos,
          });
          await sendWhatsApp(from,
            `Got ${allPhotos.length} photo${allPhotos.length > 1 ? 's' : ''}. What's the asking price on this one? (e.g. R2 500 000)`
          );
        } else {
          await sendWhatsApp(from,
            `Send me the Property24 link and I'll pull the photos automatically, or forward me the listing photos directly.`
          );
        }
        break;
      }

      // ── AWAITING ASKING PRICE ───────────────────────────────────
      case 'awaiting_asking_price': {
        const price = parsePrice(body);

        if (price && price >= 50000) {
          await upsertConversation(phoneNumber, {
            state: 'awaiting_payment',
            asking_price: price,
          });

          // Refresh conv to get latest data
          conv = await getConversation(phoneNumber);

          // Create a placeholder property + order for the PayFast link
          const { rows: propRows } = await pool.query(
            `INSERT INTO properties (erf_number, address_raw)
             VALUES ($1, $2)
             ON CONFLICT (erf_number) DO UPDATE SET address_raw = EXCLUDED.address_raw
             RETURNING id`,
            [`UNVERIFIED_WA_${phoneNumber}_${Date.now()}`, conv.input_data]
          );
          const propertyId = propRows[0].id;

          const { rows: orderRows } = await pool.query(
            `INSERT INTO orders (property_id, phone_number, price_zar, payment_status)
             VALUES ($1, $2, 149, 'pending')
             RETURNING id`,
            [propertyId, phoneNumber]
          );
          const orderId = orderRows[0].id;

          await upsertConversation(phoneNumber, {
            state: 'payment_pending',
            order_id: orderId,
          });

          const payUrl = generatePayFastURL(orderId, 149);
          const priceFormatted = 'R' + price.toLocaleString('en-ZA');

          await sendWhatsApp(from,
            `I'll run a full check on this property — sales history, comparable prices, structural risk flags, and a clear recommendation.\n\nAsking price: ${priceFormatted}\n\nYour Surepath report is R149. Here's your payment link:\n\n${payUrl}`
          );
        } else {
          await sendWhatsApp(from,
            `What's the asking price on this one? (e.g. R2 500 000)`
          );
        }
        break;
      }

      // ── PAYMENT PENDING ─────────────────────────────────────────
      case 'payment_pending': {
        await sendWhatsApp(from,
          `Waiting for payment confirmation. Once paid, your report will be ready within 15 minutes.`
        );
        break;
      }

      // ── REPORT READY ────────────────────────────────────────────
      case 'report_ready': {
        await sendWhatsApp(from,
          `Your report was already delivered. If you have questions about what we found, reply here. To check another property, just send me a new address or Property24 link.`
        );
        // Reset state for next property
        await upsertConversation(phoneNumber, { state: 'awaiting_property' });
        break;
      }

      default: {
        await upsertConversation(phoneNumber, { state: 'awaiting_property' });
        await sendWhatsApp(from,
          `Welcome to Surepath. Send me the Property24 link or the address of the property you're looking at.`
        );
      }
    }

    // Twilio expects a TwiML response or empty 200
    res.type('text/xml').send('<Response></Response>');

  } catch (err) {
    console.error(`[whatsapp] Error handling message from ${phoneNumber}:`, err);
    res.type('text/xml').send('<Response></Response>');
  }
});

// ─── PayFast ITN webhook (POST /webhook/payfast) ──────────────────────

function validatePayFastSignature(data, passphrase) {
  // Build param string from data in the order received, excluding 'signature'
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

  // Step 1: Return 200 immediately (PayFast requires response within 30s)
  res.sendStatus(200);

  try {
    // Step 2: Validate signature
    if (!validatePayFastSignature(data, process.env.PAYFAST_PASSPHRASE || '')) {
      console.error('[payfast] Invalid signature — ignoring');
      return;
    }

    // Step 3: Check payment status
    if (data.payment_status !== 'COMPLETE') {
      console.log(`[payfast] Payment not complete: ${data.payment_status}`);
      return;
    }

    const orderId = parseInt(data.m_payment_id);
    if (isNaN(orderId)) {
      console.error('[payfast] Invalid m_payment_id');
      return;
    }

    // Step 4: Find the order
    const { rows: orders } = await pool.query(
      'SELECT * FROM orders WHERE id = $1',
      [orderId]
    );

    if (orders.length === 0) {
      console.error(`[payfast] Order ${orderId} not found`);
      return;
    }

    const order = orders[0];

    // Step 5: Update order payment status
    await pool.query(
      `UPDATE orders SET payment_status = 'paid', payfast_payment_id = $1 WHERE id = $2`,
      [data.pf_payment_id, orderId]
    );

    console.log(`[payfast] Order ${orderId} marked as paid`);

    // Step 6: Get conversation data for this phone number
    const conv = await getConversation(order.phone_number);
    if (!conv) {
      console.error(`[payfast] No conversation found for ${order.phone_number}`);
      return;
    }

    // Step 7: Run the pipeline asynchronously
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
    // Notify customer that we're working on it
    await sendWhatsApp(phoneNumber,
      `Payment received! Generating your Surepath report now. This takes about 10-15 minutes.`
    );

    // Run the full pipeline
    const input = conv.input_data;
    const askingPrice = conv.asking_price;

    console.log(`[pipeline] Starting for order ${order.id}: "${input}", R${askingPrice}`);

    const result = await generateReport(input, askingPrice, phoneNumber);

    // Update order with report
    await pool.query(
      `UPDATE orders SET report_id = $1, report_delivered_at = NOW() WHERE id = $2`,
      [result.report_id, order.id]
    );

    // Update conversation state
    await upsertConversation(phoneNumber, { state: 'report_ready' });

    // Send PDF to customer via WhatsApp
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
      `Something went wrong generating your report. Our team has been notified and will sort this out within the hour. Sorry about that.`
    );
  }
}

module.exports = router;
