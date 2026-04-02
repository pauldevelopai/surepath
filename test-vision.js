const vision = require('./vision');
const pool = require('./db');

// Three sample property images for testing (Unsplash — freely licensed)
const TEST_IMAGES = [
  'https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=640', // house exterior
  'https://images.unsplash.com/photo-1560185893-a55cbc8c57e8?w=640', // interior room
  'https://images.unsplash.com/photo-1584622650111-993a426fbf0a?w=640', // bathroom
];

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

// ─── Unit tests (no API key needed) ────────────────────────────────────

async function testParseVisionResponse() {
  console.log('\n=== VISION: parseVisionResponse ===');

  // Plain JSON
  const r1 = vision.parseVisionResponse('{"photo_type":"roof"}');
  assert(r1.photo_type === 'roof', 'parses plain JSON');

  // With markdown fences
  const r2 = vision.parseVisionResponse('```json\n{"photo_type":"exterior"}\n```');
  assert(r2.photo_type === 'exterior', 'strips markdown fences');

  // Array
  const r3 = vision.parseVisionResponse('[{"photo_type":"interior"}]');
  assert(Array.isArray(r3), 'parses JSON array');
}

async function testAggregateFindings() {
  console.log('\n=== VISION: aggregateFindings ===');

  const mockAnalyses = [
    {
      photo_type: 'exterior',
      findings: [
        {
          category: 'walls',
          observation: 'Horizontal crack along plaster line',
          confidence: 'CONFIRMED_VISIBLE',
          severity: 'HIGH',
          estimated_repair_cost_zar: { min: 5000, max: 12000 },
          relevant_to: ['consumer', 'insurance', 'trades'],
        },
        {
          category: 'damp',
          observation: 'Rising damp staining on north wall',
          confidence: 'PROBABLE',
          severity: 'MEDIUM',
          estimated_repair_cost_zar: { min: 15000, max: 35000 },
          relevant_to: ['consumer', 'insurance', 'trades'],
        },
      ],
      roof_material: 'corrugated_cement',
      solar_installed: false,
      roof_orientation_estimate: 'north',
      asbestos_indicators: true,
      security_visible: true,
    },
    {
      photo_type: 'interior',
      findings: [
        {
          category: 'electrical',
          observation: 'Old push-button DB board — pre-2000',
          confidence: 'CONFIRMED_VISIBLE',
          severity: 'HIGH',
          estimated_repair_cost_zar: { min: 18000, max: 35000 },
          relevant_to: ['consumer', 'insurance', 'trades'],
        },
      ],
      roof_material: 'unknown',
      solar_installed: false,
      roof_orientation_estimate: 'unclear',
      asbestos_indicators: false,
      security_visible: false,
    },
    {
      photo_type: 'roof',
      findings: [
        {
          category: 'roof',
          observation: 'Corrugated sheeting discolouration — possible asbestos cement',
          confidence: 'PROBABLE',
          severity: 'CRITICAL',
          estimated_repair_cost_zar: { min: 45000, max: 120000 },
          relevant_to: ['consumer', 'insurance', 'trades', 'solar'],
        },
      ],
      roof_material: 'corrugated_cement',
      solar_installed: false,
      roof_orientation_estimate: 'north',
      asbestos_indicators: true,
      security_visible: false,
    },
  ];

  const agg = vision.aggregateFindings(mockAnalyses);

  assert(agg.vision_findings.length === 4, `total findings: ${agg.vision_findings.length}`);
  assert(agg.asbestos_risk === 'CRITICAL', `asbestos_risk: ${agg.asbestos_risk} (corrugated_cement + indicators)`);
  assert(agg.roof_material === 'corrugated_cement', `roof_material: ${agg.roof_material}`);
  assert(agg.solar_installed === false, 'solar_installed: false');
  assert(agg.security_visible === true, 'security_visible: true');
  assert(agg.structural_flags.length === 1, `structural_flags: ${agg.structural_flags.length} (walls crack)`);
  assert(agg.compliance_flags.length === 1, `compliance_flags: ${agg.compliance_flags.length} (DB board)`);
  assert(agg.insurance_risk_score >= 5, `insurance_risk_score: ${agg.insurance_risk_score} (high due to asbestos + severity)`);
  assert(agg.insurance_risk_score <= 10, 'insurance_risk_score <= 10');
  assert(agg.solar_suitability_score >= 1, `solar_suitability_score: ${agg.solar_suitability_score}`);
  assert(agg.solar_suitability_score <= 10, 'solar_suitability_score <= 10');
  assert(agg.repair_estimates.total_min_zar === 83000, `repair min: R${agg.repair_estimates.total_min_zar}`);
  assert(agg.repair_estimates.total_max_zar === 202000, `repair max: R${agg.repair_estimates.total_max_zar}`);
  assert(agg.maintenance_cost_estimate === 202000, `maintenance_cost_estimate: R${agg.maintenance_cost_estimate}`);
  assert(agg.trades_flags.length > 0, `trades_flags categories: ${agg.trades_flags.length}`);

  // Print the full aggregated output
  console.log('\n  --- Aggregated output ---');
  console.log(JSON.stringify(agg, null, 2).split('\n').map(l => '  ' + l).join('\n'));
}

async function testDownloadImage() {
  console.log('\n=== VISION: downloadImage ===');

  try {
    const buffer = await vision.downloadImage(TEST_IMAGES[0]);
    assert(Buffer.isBuffer(buffer), 'returns a Buffer');
    assert(buffer.length > 10000, `image size: ${buffer.length} bytes`);
    // Check JPEG magic bytes
    const isJpeg = buffer[0] === 0xFF && buffer[1] === 0xD8;
    const isPng = buffer[0] === 0x89 && buffer[1] === 0x50;
    assert(isJpeg || isPng, `valid image format (JPEG=${isJpeg}, PNG=${isPng})`);
  } catch (err) {
    console.log(`  FAIL: download error: ${err.message}`);
    failed++;
  }
}

// ─── Live API test ─────────────────────────────────────────────────────

async function testLiveAnalysis() {
  console.log('\n=== VISION: live Claude Vision analysis (3 images) ===');

  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('  SKIP: ANTHROPIC_API_KEY not set');
    return;
  }

  // Download all 3 test images
  const images = [];
  for (const url of TEST_IMAGES) {
    try {
      const buffer = await vision.downloadImage(url);
      const isJpeg = buffer[0] === 0xFF && buffer[1] === 0xD8;
      images.push({
        url,
        base64: buffer.toString('base64'),
        mediaType: isJpeg ? 'image/jpeg' : 'image/png',
      });
      console.log(`  Downloaded: ${url.split('/').pop()} (${buffer.length} bytes)`);
    } catch (err) {
      console.log(`  FAIL: could not download ${url}: ${err.message}`);
      failed++;
    }
  }

  if (images.length === 0) return;

  console.log(`  Calling Claude Vision (claude-opus-4-5) with ${images.length} images...`);
  const analyses = await vision.analyseBatch(images);

  assert(Array.isArray(analyses), 'returns array of analyses');
  assert(analyses.length >= 1, `got ${analyses.length} analysis result(s)`);

  for (let i = 0; i < analyses.length; i++) {
    const a = analyses[i];
    console.log(`\n  --- Image ${i + 1} analysis ---`);
    assert(typeof a.photo_type === 'string', `photo_type: ${a.photo_type}`);
    assert(Array.isArray(a.findings), `findings is array (${(a.findings || []).length} items)`);
    assert(typeof a.roof_material === 'string', `roof_material: ${a.roof_material}`);
    assert(typeof a.solar_installed === 'boolean', `solar_installed: ${a.solar_installed}`);
    assert(typeof a.asbestos_indicators === 'boolean', `asbestos_indicators: ${a.asbestos_indicators}`);
    assert(typeof a.security_visible === 'boolean', `security_visible: ${a.security_visible}`);

    if (a.findings && a.findings.length > 0) {
      for (const f of a.findings) {
        console.log(`    [${f.severity}] ${f.category}: ${f.observation}`);
        if (f.estimated_repair_cost_zar) {
          console.log(`      Cost: R${f.estimated_repair_cost_zar.min} - R${f.estimated_repair_cost_zar.max}`);
        }
      }
    }
  }

  // Aggregate
  const agg = vision.aggregateFindings(analyses);
  console.log('\n  --- Aggregated across all images ---');
  console.log(`    Total findings: ${agg.vision_findings.length}`);
  console.log(`    Roof material: ${agg.roof_material}`);
  console.log(`    Asbestos risk: ${agg.asbestos_risk}`);
  console.log(`    Insurance risk score: ${agg.insurance_risk_score}/10`);
  console.log(`    Solar suitability score: ${agg.solar_suitability_score}/10`);
  console.log(`    Repair estimate: R${agg.repair_estimates.total_min_zar} - R${agg.repair_estimates.total_max_zar}`);
  console.log(`    Security visible: ${agg.security_visible}`);
  console.log(`    Trades categories: ${agg.trades_flags.map(t => t.trade_type).join(', ') || 'none'}`);
}

// ─── Run ───────────────────────────────────────────────────────────────

async function run() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  SUREPATH VISION MODULE TESTS                ║');
  console.log('╚══════════════════════════════════════════════╝');

  console.log(`\nEnvironment:`);
  console.log(`  ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? 'SET' : 'NOT SET'}`);
  console.log(`  DATABASE_URL:     ${process.env.DATABASE_URL ? 'SET' : 'NOT SET'}`);

  await testParseVisionResponse();
  await testAggregateFindings();
  await testDownloadImage();
  await testLiveAnalysis();

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
