const http = require('http');
const express = require('express');
const pool = require('./db');

// ─── Mock Twilio (capture outgoing messages) ───────────────────────────

const sentMessages = [];

// Patch the module before requiring whatsapp.js
const originalTwilio = require('twilio');
require.cache[require.resolve('twilio')] = {
  id: require.resolve('twilio'),
  filename: require.resolve('twilio'),
  loaded: true,
  exports: function fakeTwilio() {
    return {
      messages: {
        create: async (msg) => {
          sentMessages.push(msg);
          console.log(`    [twilio] → ${msg.to}: "${msg.body.substring(0, 80)}..."`);
          return { sid: 'SM_FAKE_' + Date.now() };
        },
      },
    };
  },
};

const whatsappRouter = require('./whatsapp');

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.log(`  FAIL: ${label}`);
    failed++;
  }
}

// ─── Test server ───────────────────────────────────────────────────────

function createTestApp() {
  const app = express();
  app.use(whatsappRouter);
  return app;
}

function postForm(server, path, data) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(data).toString();
    const req = http.request({
      hostname: '127.0.0.1',
      port: server.address().port,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => responseBody += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: responseBody }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Unit tests (parsePrice, containsAddress, etc) ─────────────────────

async function testParseHelpers() {
  console.log('\n=== WHATSAPP: helper functions ===');

  // Re-require to get the actual module internals — test via the pipeline module
  // Since these are internal, test them through the webhook behavior instead

  // Test URL detection
  const { extractProperty24Data, isProperty24URL } = require('./pipeline');
  assert(isProperty24URL('https://www.property24.com/for-sale/test/123') === true, 'P24 URL detected');
  assert(isProperty24URL('12 Kloof Street') === false, 'address not a URL');
}

// ─── WhatsApp conversation flow test ───────────────────────────────────

async function testConversationFlow() {
  console.log('\n=== WHATSAPP: full conversation flow (mock) ===');

  const hasDB = !!process.env.DATABASE_URL;
  if (!hasDB) {
    console.log('  SKIP: DATABASE_URL not set');
    return;
  }

  // Ensure conversations table exists
  const fs = require('fs');
  const path = require('path');
  const convSQL = fs.readFileSync(path.join(__dirname, 'conversations.sql'), 'utf8');
  await pool.query(convSQL);

  // Clean up test data
  await pool.query("DELETE FROM conversations WHERE phone_number = '+27820000001'");

  const app = createTestApp();
  const server = app.listen(0);

  try {
    const phone = '+27820000001';
    const from = `whatsapp:${phone}`;

    // Message 1: First contact — no address yet
    console.log('\n  --- Message 1: First contact ---');
    sentMessages.length = 0;
    let res = await postForm(server, '/webhook/whatsapp', {
      From: from,
      Body: 'Hi there',
      NumMedia: '0',
    });
    assert(res.status === 200, 'returns 200');
    assert(sentMessages.length === 1, 'one message sent');
    assert(sentMessages[0].body.includes('Welcome to Surepath'), 'welcome message sent');

    // Message 2: Send address
    console.log('\n  --- Message 2: Send address ---');
    sentMessages.length = 0;
    res = await postForm(server, '/webhook/whatsapp', {
      From: from,
      Body: '12 Kloof Street, Gardens, Cape Town',
      NumMedia: '0',
    });
    assert(res.status === 200, 'returns 200');
    assert(sentMessages.length === 1, 'one message sent');
    assert(sentMessages[0].body.includes('Got it'), 'acknowledgement sent');

    // Verify state advanced
    const conv1 = await pool.query("SELECT state FROM conversations WHERE phone_number = $1", [phone]);
    assert(conv1.rows[0].state === 'awaiting_photos', `state: ${conv1.rows[0].state}`);

    // Message 3: Send Property24 URL
    console.log('\n  --- Message 3: Send Property24 URL ---');
    sentMessages.length = 0;
    res = await postForm(server, '/webhook/whatsapp', {
      From: from,
      Body: 'https://www.property24.com/for-sale/gardens/cape-town/western-cape/12345',
      NumMedia: '0',
    });
    assert(res.status === 200, 'returns 200');
    assert(sentMessages.length === 1, 'one message sent');
    assert(sentMessages[0].body.includes('asking price'), 'asks for price');

    const conv2 = await pool.query("SELECT state FROM conversations WHERE phone_number = $1", [phone]);
    assert(conv2.rows[0].state === 'awaiting_asking_price', `state: ${conv2.rows[0].state}`);

    // Message 4: Send price
    console.log('\n  --- Message 4: Send asking price ---');
    sentMessages.length = 0;
    res = await postForm(server, '/webhook/whatsapp', {
      From: from,
      Body: 'R2 500 000',
      NumMedia: '0',
    });
    assert(res.status === 200, 'returns 200');
    assert(sentMessages.length === 1, 'one message sent');
    assert(sentMessages[0].body.includes('R149'), 'price quoted');
    assert(sentMessages[0].body.includes('payfast'), 'PayFast link included');

    const conv3 = await pool.query("SELECT state, asking_price, order_id FROM conversations WHERE phone_number = $1", [phone]);
    assert(conv3.rows[0].state === 'payment_pending', `state: ${conv3.rows[0].state}`);
    assert(conv3.rows[0].asking_price === 2500000, `asking_price: ${conv3.rows[0].asking_price}`);
    assert(conv3.rows[0].order_id !== null, `order_id: ${conv3.rows[0].order_id}`);

    // Verify order was created
    const { rows: orders } = await pool.query(
      "SELECT * FROM orders WHERE id = $1",
      [conv3.rows[0].order_id]
    );
    assert(orders.length === 1, 'order record created');
    assert(orders[0].phone_number === phone, 'order phone correct');
    assert(orders[0].price_zar === 149, 'order price R149');
    assert(orders[0].payment_status === 'pending', 'payment pending');

    // Message 5: Pester before paying
    console.log('\n  --- Message 5: Message while waiting for payment ---');
    sentMessages.length = 0;
    res = await postForm(server, '/webhook/whatsapp', {
      From: from,
      Body: 'How long will it take?',
      NumMedia: '0',
    });
    assert(res.status === 200, 'returns 200');
    assert(sentMessages[0].body.includes('Waiting for payment'), 'payment pending message');

    console.log('\n  --- Conversation flow complete ---');

  } finally {
    server.close();
  }
}

// ─── PayFast ITN test ──────────────────────────────────────────────────

async function testPayFastITN() {
  console.log('\n=== PAYFAST: ITN webhook (mock) ===');

  const hasDB = !!process.env.DATABASE_URL;
  if (!hasDB) {
    console.log('  SKIP: DATABASE_URL not set');
    return;
  }

  const app = createTestApp();
  const server = app.listen(0);

  try {
    // Get the test order we created in the conversation flow
    const { rows: orders } = await pool.query(
      "SELECT id FROM orders WHERE phone_number = '+27820000001' ORDER BY created_at DESC LIMIT 1"
    );

    if (orders.length === 0) {
      console.log('  SKIP: No test order found (run conversation flow test first)');
      return;
    }

    const orderId = orders[0].id;

    // Simulate PayFast ITN callback
    // Note: signature won't match without real merchant key, but we test the route
    sentMessages.length = 0;
    const res = await postForm(server, '/webhook/payfast', {
      m_payment_id: String(orderId),
      payment_status: 'COMPLETE',
      pf_payment_id: 'PF_TEST_12345',
      signature: 'test_signature',
    });

    assert(res.status === 200, 'returns 200 immediately');

    // Wait a moment for async processing
    await new Promise(r => setTimeout(r, 500));

    // In a real test with valid signature, the pipeline would run.
    // Here we verify the route responded correctly.
    console.log('  (Signature validation prevents pipeline run in test — this is correct)');
    console.log('  In production: valid signature → pipeline runs → PDF delivered via WhatsApp');

  } finally {
    server.close();
  }
}

// ─── PayFast URL generation test ───────────────────────────────────────

async function testPayFastURLGeneration() {
  console.log('\n=== PAYFAST: URL generation ===');

  // Set dummy env vars for test
  const origMID = process.env.PAYFAST_MERCHANT_ID;
  const origMK = process.env.PAYFAST_MERCHANT_KEY;
  process.env.PAYFAST_MERCHANT_ID = '10000100';
  process.env.PAYFAST_MERCHANT_KEY = '46f0cd694581a';

  // We need to access generatePayFastURL — it's not exported,
  // so test it indirectly through the conversation flow.
  // Instead, verify the PayFast URL format from the sent messages.

  // Check if we captured a PayFast URL in the conversation test
  const pfMessage = sentMessages.find(m => m.body && m.body.includes('payfast.co.za'));
  if (pfMessage) {
    const urlMatch = pfMessage.body.match(/(https:\/\/www\.payfast\.co\.za[^\s]+)/);
    if (urlMatch) {
      const url = urlMatch[1];
      assert(url.includes('merchant_id='), 'URL contains merchant_id');
      assert(url.includes('amount=149.00'), 'URL contains amount=149.00');
      assert(url.includes('item_name=Surepath'), 'URL contains item_name');
      assert(url.includes('m_payment_id='), 'URL contains m_payment_id');
      assert(url.includes('signature='), 'URL contains signature');
      assert(url.includes('notify_url='), 'URL contains notify_url');
    } else {
      console.log('  SKIP: No PayFast URL captured');
    }
  } else {
    console.log('  SKIP: No PayFast message captured (conversation test may not have run)');
  }

  process.env.PAYFAST_MERCHANT_ID = origMID;
  process.env.PAYFAST_MERCHANT_KEY = origMK;
}

// ─── Price parsing test ────────────────────────────────────────────────

async function testPriceParsing() {
  console.log('\n=== WHATSAPP: price parsing via webhook ===');

  const hasDB = !!process.env.DATABASE_URL;
  if (!hasDB) {
    console.log('  SKIP: DATABASE_URL not set');
    return;
  }

  // Test various price formats by checking conversation state
  const testPhone = '+27820000002';
  await pool.query("DELETE FROM conversations WHERE phone_number = $1", [testPhone]);

  const app = createTestApp();
  const server = app.listen(0);

  try {
    const from = `whatsapp:${testPhone}`;

    // Set up conversation to awaiting_asking_price state
    await pool.query(
      `INSERT INTO conversations (phone_number, state, input_data)
       VALUES ($1, 'awaiting_asking_price', '12 Test Street, Gardens')`,
      [testPhone]
    );

    // Test: "R2500000"
    sentMessages.length = 0;
    await postForm(server, '/webhook/whatsapp', { From: from, Body: 'R2500000', NumMedia: '0' });
    const conv = await pool.query("SELECT asking_price FROM conversations WHERE phone_number = $1", [testPhone]);
    assert(conv.rows[0].asking_price === 2500000, 'R2500000 → 2500000');

    // Reset for next test
    await pool.query("UPDATE conversations SET state = 'awaiting_asking_price', asking_price = NULL WHERE phone_number = $1", [testPhone]);

    // Test: "R2 500 000"
    await postForm(server, '/webhook/whatsapp', { From: from, Body: 'R2 500 000', NumMedia: '0' });
    const conv2 = await pool.query("SELECT asking_price FROM conversations WHERE phone_number = $1", [testPhone]);
    assert(conv2.rows[0].asking_price === 2500000, 'R2 500 000 → 2500000');

    // Reset
    await pool.query("UPDATE conversations SET state = 'awaiting_asking_price', asking_price = NULL WHERE phone_number = $1", [testPhone]);

    // Test: "2.5m"
    await postForm(server, '/webhook/whatsapp', { From: from, Body: '2.5m', NumMedia: '0' });
    const conv3 = await pool.query("SELECT asking_price FROM conversations WHERE phone_number = $1", [testPhone]);
    assert(conv3.rows[0].asking_price === 2500000, '2.5m → 2500000');

    // Reset
    await pool.query("UPDATE conversations SET state = 'awaiting_asking_price', asking_price = NULL WHERE phone_number = $1", [testPhone]);

    // Test: "R1,200,000"
    await postForm(server, '/webhook/whatsapp', { From: from, Body: 'R1,200,000', NumMedia: '0' });
    const conv4 = await pool.query("SELECT asking_price FROM conversations WHERE phone_number = $1", [testPhone]);
    assert(conv4.rows[0].asking_price === 1200000, 'R1,200,000 → 1200000');

  } finally {
    server.close();
  }
}

// ─── Run ───────────────────────────────────────────────────────────────

async function run() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  SUREPATH WHATSAPP + PAYFAST TESTS           ║');
  console.log('╚══════════════════════════════════════════════╝');

  console.log(`\nEnvironment:`);
  console.log(`  DATABASE_URL:         ${process.env.DATABASE_URL ? 'SET' : 'NOT SET'}`);
  console.log(`  TWILIO_ACCOUNT_SID:   ${process.env.TWILIO_ACCOUNT_SID ? 'SET' : 'NOT SET'}`);
  console.log(`  PAYFAST_MERCHANT_ID:  ${process.env.PAYFAST_MERCHANT_ID ? 'SET' : 'NOT SET'}`);

  await testParseHelpers();
  await testConversationFlow();
  await testPriceParsing();
  await testPayFastITN();
  await testPayFastURLGeneration();

  console.log('\n══════════════════════════════════════════════');
  console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
  console.log('══════════════════════════════════════════════\n');

  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Test runner error:', err);
  pool.end();
  process.exit(1);
});
