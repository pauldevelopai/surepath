const pool = require('./db');
const { generateReport, isProperty24URL, extractProperty24Data } = require('./pipeline');

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

// ─── Unit tests (no API keys needed) ───────────────────────────────────

async function testIsProperty24URL() {
  console.log('\n=== PIPELINE: isProperty24URL ===');

  assert(isProperty24URL('https://www.property24.com/for-sale/gardens/cape-town/123456') === true, 'property24.com URL detected');
  assert(isProperty24URL('https://property24.com/listing/456') === true, 'property24.com without www');
  assert(isProperty24URL('12 Kloof Street, Gardens, Cape Town') === false, 'address string rejected');
  assert(isProperty24URL('https://privateproperty.co.za/listing/789') === false, 'other property site rejected');
}

async function testExtractProperty24Data() {
  console.log('\n=== PIPELINE: extractProperty24Data ===');

  const mockHTML = `
    <html>
    <head>
      <title>3 Bedroom House for Sale in Gardens - Property24</title>
      <script type="application/ld+json">
        {"@type": "Product", "address": {"streetAddress": "14 Kloof Street", "addressLocality": "Gardens", "addressRegion": "Cape Town"}}
      </script>
    </head>
    <body>
      <img src="https://img-cdn-p24.property24.com/photos/123/exterior.jpg" />
      <img src="https://img-cdn-p24.property24.com/photos/123/interior1.jpg" />
      <img src="https://img-cdn-p24.property24.com/photos/123/bathroom.jpg" />
      <img data-src="https://img-cdn-p24.property24.com/photos/123/kitchen.jpg" />
      <img src="https://property24.com/images/logo.png" />
    </body>
    </html>
  `;

  const result = extractProperty24Data(mockHTML);

  assert(result.address === '14 Kloof Street, Gardens, Cape Town', `address: ${result.address}`);
  assert(result.photoUrls.length >= 3, `photos found: ${result.photoUrls.length}`);
  assert(result.photoUrls.every(u => !u.includes('logo')), 'logo excluded');
  assert(result.photoUrls.some(u => u.includes('exterior')), 'exterior photo included');
}

async function testExtractProperty24Fallback() {
  console.log('\n=== PIPELINE: extractProperty24Data (title fallback) ===');

  const mockHTML = `
    <html>
    <head><title>2 Bed Apartment for Sale in Rosebank - R1,200,000 | Property24</title></head>
    <body>
      <h1>Beautiful Apartment in Rosebank</h1>
      <img src="https://p24.property24.com/cdn/photo1.jpg" />
    </body>
    </html>
  `;

  const result = extractProperty24Data(mockHTML);

  assert(result.address === 'Rosebank', `fallback address from title: ${result.address}`);
  assert(result.photoUrls.length >= 1, `photos: ${result.photoUrls.length}`);
}

// ─── Live pipeline test ────────────────────────────────────────────────

async function testFullPipeline() {
  console.log('\n=== PIPELINE: full generateReport (live) ===');

  const hasDB = !!process.env.DATABASE_URL;
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;

  if (!hasDB) {
    console.log('  SKIP: DATABASE_URL not set');
    return;
  }
  if (!hasAnthropic) {
    console.log('  SKIP: ANTHROPIC_API_KEY not set');
    return;
  }

  console.log('\n  Running full pipeline on "12 Kloof Street, Gardens, Cape Town"...\n');

  const result = await generateReport(
    '12 Kloof Street, Gardens, Cape Town',
    2500000,
    '+27821234567'
  );

  console.log('\n  --- Pipeline result ---');
  assert(result !== null, 'returns a result');
  assert(typeof result.report_id === 'number', `report_id: ${result.report_id}`);
  assert(typeof result.pdf_url === 'string', `pdf_url: ${result.pdf_url}`);
  assert(['BUY', 'NEGOTIATE', 'INSPECT_FIRST', 'WALK_AWAY'].includes(result.decision), `decision: ${result.decision}`);
  assert(typeof result.decision_reasoning === 'string', `reasoning: ${result.decision_reasoning}`);
  assert(result.was_resale === false, 'was_resale: false (fresh report)');

  // Verify DB state
  const { rows: orders } = await pool.query(
    'SELECT * FROM orders WHERE report_id = $1',
    [result.report_id]
  );
  assert(orders.length > 0, `order created for report ${result.report_id}`);
  assert(orders[0].phone_number === '+27821234567', 'order has correct phone');
  assert(orders[0].price_zar === 149, 'order price is R149');

  const { rows: reports } = await pool.query(
    'SELECT status, times_sold, decision FROM property_reports WHERE id = $1',
    [result.report_id]
  );
  assert(reports[0].status === 'complete', 'report status is complete');
  assert(reports[0].times_sold >= 1, `times_sold: ${reports[0].times_sold}`);

  console.log('\n  --- Full output ---');
  console.log(JSON.stringify(result, null, 2));

  // Test resale path (run again for same property)
  console.log('\n  Running pipeline again (should trigger resale)...\n');

  const resaleResult = await generateReport(
    '12 Kloof Street, Gardens, Cape Town',
    2500000,
    '+27839999999'
  );

  // Note: resale only triggers if same property_id found — with PENDING_ erf
  // this creates a new property each time. In production, Windeed provides
  // the real erf_number for dedup.
  console.log(`  Resale result: was_resale=${resaleResult.was_resale}`);
}

// ─── Run ───────────────────────────────────────────────────────────────

async function run() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  SUREPATH PIPELINE TESTS                     ║');
  console.log('╚══════════════════════════════════════════════╝');

  console.log(`\nEnvironment:`);
  console.log(`  DATABASE_URL:        ${process.env.DATABASE_URL ? 'SET' : 'NOT SET'}`);
  console.log(`  ANTHROPIC_API_KEY:   ${process.env.ANTHROPIC_API_KEY ? 'SET' : 'NOT SET'}`);
  console.log(`  GOOGLE_MAPS_API_KEY: ${process.env.GOOGLE_MAPS_API_KEY ? 'SET' : 'NOT SET'}`);
  console.log(`  WINDEED_API_KEY:     ${process.env.WINDEED_API_KEY ? 'SET' : 'NOT SET'}`);
  console.log(`  AWS_S3_BUCKET:       ${process.env.AWS_S3_BUCKET ? 'SET' : 'NOT SET'}`);

  await testIsProperty24URL();
  await testExtractProperty24Data();
  await testExtractProperty24Fallback();
  await testFullPipeline();

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
