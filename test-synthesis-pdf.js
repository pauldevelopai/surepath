const pool = require('./db');
const { synthesiseReport, classifyEra, AGE_RISK_MATRIX, getSuburbIntelligence } = require('./synthesis');
const { renderReport, renderReportBuffer, buildHTML } = require('./pdf');

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

// ─── Unit tests (no DB or API needed) ──────────────────────────────────

async function testClassifyEra() {
  console.log('\n=== SYNTHESIS: classifyEra ===');

  assert(classifyEra('1960s') === 'pre-1977', '1960s → pre-1977');
  assert(classifyEra('1970') === 'pre-1977', '1970 → pre-1977');
  assert(classifyEra('1977') === '1977-1990', '1977 → 1977-1990');
  assert(classifyEra('1985') === '1977-1990', '1985 → 1977-1990');
  assert(classifyEra('1980s') === '1977-1990', '1980s → 1977-1990');
  assert(classifyEra('1995') === '1990-2000', '1995 → 1990-2000');
  assert(classifyEra('1990s') === '1990-2000', '1990s → 1990-2000');
  assert(classifyEra('2005') === '2000-2010', '2005 → 2000-2010');
  assert(classifyEra('2000s') === '2000-2010', '2000s → 2000-2010');
  assert(classifyEra('2015') === 'post-2010', '2015 → post-2010');
  assert(classifyEra('2020s') === 'post-2010', '2020s → post-2010');
  assert(classifyEra(null) === 'pre-1977', 'null → pre-1977 (worst case)');
  assert(classifyEra('unknown') === 'pre-1977', 'unknown → pre-1977');
  assert(classifyEra('victorian') === 'pre-1977', 'victorian → pre-1977');
  assert(classifyEra('modern') === 'post-2010', 'modern → post-2010');
}

async function testAgeRiskMatrix() {
  console.log('\n=== SYNTHESIS: AGE_RISK_MATRIX ===');

  const pre77 = AGE_RISK_MATRIX['pre-1977'];
  assert(pre77.asbestos === 'CRITICAL', 'pre-1977 asbestos: CRITICAL');
  assert(pre77.electrical === 'CRITICAL', 'pre-1977 electrical: CRITICAL');
  assert(pre77.plumbing === 'HIGH', 'pre-1977 plumbing: HIGH');

  const m80 = AGE_RISK_MATRIX['1977-1990'];
  assert(m80.asbestos === 'HIGH', '1977-1990 asbestos: HIGH');
  assert(m80.electrical === 'HIGH', '1977-1990 electrical: HIGH');
  assert(m80.plumbing === 'MEDIUM', '1977-1990 plumbing: MEDIUM');

  const m90 = AGE_RISK_MATRIX['1990-2000'];
  assert(m90.asbestos === 'MEDIUM', '1990-2000 asbestos: MEDIUM');

  const m00 = AGE_RISK_MATRIX['2000-2010'];
  assert(m00.asbestos === 'NEGLIGIBLE', '2000-2010 asbestos: NEGLIGIBLE');

  const post10 = AGE_RISK_MATRIX['post-2010'];
  assert(post10.asbestos === 'NEGLIGIBLE', 'post-2010 asbestos: NEGLIGIBLE');
  assert(post10.electrical === 'LOW', 'post-2010 electrical: LOW');
}

async function testSuburbIntel() {
  console.log('\n=== SYNTHESIS: getSuburbIntelligence ===');

  const intel = await getSuburbIntelligence('Gardens', 'Cape Town');
  assert(intel.suburb === 'Gardens', 'suburb correct');
  assert(intel.city === 'Cape Town', 'city correct');
  assert(typeof intel.total_reports_in_suburb === 'number', 'total_reports_in_suburb is number');
  assert(intel.source === 'surepath_reports' || intel.source === 'no_suburb_data', `source: ${intel.source}`);
}

async function testBuildHTML() {
  console.log('\n=== PDF: buildHTML ===');

  const mockReport = {
    asking_price: 2850000,
    avm_low: 2400000,
    avm_high: 2900000,
    price_verdict: 'fair',
    comparables: [
      { address: '10 Kloof St', price: 2700000, sold_date: '2025-11-01', size_sqm: 210 },
    ],
    suburb_intelligence: { avg_price_sqm: 12800, median_days_on_market: 45, price_trend_12m: '+3.2%' },
    vision_findings: [
      { category: 'roof', observation: 'Moss growth on tiles', severity: 'LOW', confidence: 'CONFIRMED_VISIBLE', estimated_repair_cost_zar: { min: 5000, max: 15000 } },
      { category: 'walls', observation: 'Hairline crack on gable', severity: 'MEDIUM', confidence: 'CONFIRMED_VISIBLE', estimated_repair_cost_zar: { min: 8000, max: 15000 } },
    ],
    asbestos_risk: 'MEDIUM',
    structural_flags: [{ observation: 'Hairline crack on gable wall', severity: 'MEDIUM' }],
    compliance_flags: [{ observation: 'DB board appears older model', severity: 'MEDIUM' }],
    repair_estimates: {
      total_min_zar: 45000, total_max_zar: 85000,
      items: [
        { category: 'roof', description: 'Moss treatment', min: 15000, max: 25000 },
        { category: 'electrical', description: 'DB board upgrade', min: 22000, max: 45000 },
      ],
    },
    negotiation_intel: {
      days_on_market: 62, price_reductions: 1,
      suggested_offer: 2700000,
      negotiation_points: ['deferred roof maintenance', 'electrical CoC needed'],
    },
    decision: 'NEGOTIATE',
    decision_reasoning: 'Asking price is at the top of the AVM range. Roof shows signs of age. Negotiate R150k off based on deferred maintenance.',
    insurance_risk_score: 6,
    insurance_flags: ['older_roof_material', 'structural_crack_visible'],
    crime_risk_score: 4,
    solar_suitability_score: 8,
    trades_flags: [{ trade_type: 'electrical', items: [{ observation: 'DB board upgrade needed' }] }],
    maintenance_cost_estimate: 85000,
  };

  const mockProperty = {
    erf_number: 'ERF12345',
    address_raw: '14 Kloof Street, Gardens, Cape Town',
    address_normalised: '14 Kloof St, Gardens, Cape Town, 8001',
    suburb: 'Gardens',
    city: 'Cape Town',
    province: 'Western Cape',
    bedrooms: 3,
    bathrooms: 2,
    floor_area_sqm: 220,
    stand_size_sqm: 650,
    construction_era: '1960s',
  };

  const mockDeeds = {
    registered_owner: 'John Smith',
    title_deed_ref: 'T12345/2020',
    municipal_value: 2500000,
    transfer_history: [
      { date: '2020-03-15', price: 2200000, buyer: 'John Smith', seller: 'Jane Doe', bond: 1800000 },
    ],
  };

  const html = buildHTML(mockReport, mockProperty, mockDeeds);

  assert(typeof html === 'string', 'returns string');
  assert(html.includes('SUREPATH'), 'contains SUREPATH heading');
  assert(html.includes('ERF12345'), 'contains ERF number');
  assert(html.includes('14 Kloof St'), 'contains address');
  assert(html.includes('#0D1B2A'), 'contains navy brand colour');
  assert(html.includes('#E63946'), 'contains accent red colour');
  assert(html.includes('NEGOTIATE'), 'contains decision');
  assert(html.includes('surepath.co.za'), 'contains footer URL');
  assert(html.includes('Confidential property report'), 'contains confidential notice');
  assert(html.includes('John Smith'), 'contains registered owner');
  assert(html.includes('Moss growth on tiles'), 'contains visual finding');
  assert(html.includes('DB board'), 'contains compliance flag');
  assert(html.includes('R150k'), 'contains decision reasoning');
  assert(html.includes('6/10') || html.includes('insurance'), 'contains insurance score');
  assert(html.length > 5000, `HTML size reasonable: ${html.length} chars`);
}

// ─── Live DB + API tests ───────────────────────────────────────────────

async function testSynthesisLive() {
  console.log('\n=== SYNTHESIS: live synthesiseReport (property_id=1) ===');

  if (!process.env.DATABASE_URL) {
    console.log('  SKIP: DATABASE_URL not set');
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('  SKIP: ANTHROPIC_API_KEY not set');
    return;
  }

  const result = await synthesiseReport(1, 2850000);

  assert(result !== null, 'returns a result');
  assert(typeof result.report_id === 'number', `report_id: ${result.report_id}`);
  assert(result.report.decision, `decision: ${result.report.decision}`);
  assert(result.report.decision_reasoning, 'has decision reasoning');
  assert(typeof result.report.insurance_risk_score === 'number', `insurance_risk_score: ${result.report.insurance_risk_score}`);
  assert(typeof result.report.crime_risk_score === 'number', `crime_risk_score: ${result.report.crime_risk_score}`);
  assert(typeof result.report.solar_suitability_score === 'number', `solar_suitability_score: ${result.report.solar_suitability_score}`);
  assert(typeof result.report.maintenance_cost_estimate === 'number', `maintenance_cost_estimate: R${result.report.maintenance_cost_estimate}`);

  console.log('\n  --- Synthesised report summary ---');
  console.log(`    Decision: ${result.report.decision}`);
  console.log(`    Reasoning: ${result.report.decision_reasoning}`);
  console.log(`    Price Verdict: ${result.report.price_verdict}`);
  console.log(`    AVM: ${result.report.avm_low} - ${result.report.avm_high}`);
  console.log(`    Insurance Risk: ${result.report.insurance_risk_score}/10`);
  console.log(`    Crime Risk: ${result.report.crime_risk_score}/10`);
  console.log(`    Solar: ${result.report.solar_suitability_score}/10`);
  console.log(`    Maintenance: R${result.report.maintenance_cost_estimate}`);
  console.log(`    Asbestos: ${result.report.asbestos_risk}`);

  return result.report_id;
}

async function testPdfRenderLive(reportId) {
  console.log('\n=== PDF: live renderReport ===');

  if (!process.env.DATABASE_URL) {
    console.log('  SKIP: DATABASE_URL not set');
    return;
  }

  // Use provided reportId or fall back to 1
  const id = reportId || 1;
  console.log(`  Rendering report ${id}...`);

  const url = await renderReport(id);

  assert(typeof url === 'string', `PDF URL/path returned: ${url}`);
  assert(url.length > 0, 'URL is not empty');

  console.log(`\n  PDF output: ${url}`);
}

// ─── Puppeteer PDF test (offline, no DB) ───────────────────────────────

async function testPdfRenderOffline() {
  console.log('\n=== PDF: offline Puppeteer render ===');

  const puppeteer = require('puppeteer');

  const mockReport = {
    asking_price: 2850000, avm_low: 2400000, avm_high: 2900000,
    price_verdict: 'fair',
    comparables: [{ address: '10 Kloof St', price: 2700000, sold_date: '2025-11-01', size_sqm: 210 }],
    suburb_intelligence: { avg_price_sqm: 12800, median_days_on_market: 45, price_trend_12m: '+3.2%' },
    vision_findings: [
      { category: 'roof', observation: 'Concrete tiles showing weathering and moss growth', severity: 'LOW', confidence: 'CONFIRMED_VISIBLE', estimated_repair_cost_zar: { min: 5000, max: 15000 } },
      { category: 'walls', observation: 'Hairline crack on north-facing gable wall', severity: 'MEDIUM', confidence: 'CONFIRMED_VISIBLE', estimated_repair_cost_zar: { min: 8000, max: 15000 } },
      { category: 'electrical', observation: 'DB board appears to be older push-button model', severity: 'HIGH', confidence: 'PROBABLE', estimated_repair_cost_zar: { min: 22000, max: 45000 } },
    ],
    asbestos_risk: 'MEDIUM',
    structural_flags: [{ observation: 'Hairline crack on gable wall — monitor for movement', severity: 'MEDIUM' }],
    compliance_flags: [{ observation: 'DB board appears older model — recommend CoC check', severity: 'MEDIUM' }],
    repair_estimates: {
      total_min_zar: 45000, total_max_zar: 85000,
      items: [
        { category: 'roof', description: 'Moss treatment and waterproofing', min: 15000, max: 25000 },
        { category: 'walls', description: 'Crack repair and repaint gable', min: 8000, max: 15000 },
        { category: 'electrical', description: 'DB board upgrade + CoC', min: 22000, max: 45000 },
      ],
    },
    negotiation_intel: {
      days_on_market: 62, price_reductions: 1,
      motivated_seller_signals: ['price already reduced once', 'listing says "must sell"'],
      suggested_offer: 2700000,
      negotiation_points: ['deferred roof maintenance', 'electrical CoC needed', 'crack on gable wall'],
    },
    decision: 'NEGOTIATE',
    decision_reasoning: 'Asking price is at the top of the AVM range. Roof shows signs of age. Negotiate R150k off based on deferred maintenance.',
    insurance_risk_score: 6,
    insurance_flags: ['older_roof_material', 'structural_crack_visible', 'electrical_compliance_unknown'],
    crime_risk_score: 4,
    solar_suitability_score: 8,
    trades_flags: [
      { trade_type: 'electrical', items: [{ observation: 'DB board upgrade and CoC', est_cost: 35000 }] },
      { trade_type: 'roofing', items: [{ observation: 'Moss treatment and waterproofing', est_cost: 20000 }] },
      { trade_type: 'painting', items: [{ observation: 'Gable wall crack repair and repaint', est_cost: 12000 }] },
    ],
    maintenance_cost_estimate: 85000,
  };

  const mockProperty = {
    erf_number: 'ERF12345', address_raw: '14 Kloof Street, Gardens, Cape Town',
    address_normalised: '14 Kloof St, Gardens, Cape Town, 8001',
    suburb: 'Gardens', city: 'Cape Town', province: 'Western Cape',
    bedrooms: 3, bathrooms: 2, floor_area_sqm: 220, stand_size_sqm: 650,
    construction_era: '1960s',
  };

  const mockDeeds = {
    registered_owner: 'John Smith', title_deed_ref: 'T12345/2020',
    municipal_value: 2500000,
    transfer_history: [
      { date: '2020-03-15', price: 2200000, buyer: 'John Smith', seller: 'Jane Doe', bond: 1800000 },
      { date: '2015-06-01', price: 1600000, buyer: 'Jane Doe', seller: 'Bob Brown', bond: 1200000 },
    ],
  };

  const html = buildHTML(mockReport, mockProperty, mockDeeds);

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0' });

  const pdfBuffer = await page.pdf({
    format: 'A4',
    printBackground: true,
    margin: { top: '20mm', bottom: '25mm', left: '15mm', right: '15mm' },
    displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate: `<div style="width:100%;text-align:center;font-size:9px;color:#888;padding:5px 0">
      surepath.co.za | Confidential property report
      <span style="float:right;margin-right:15mm">Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
    </div>`,
  });
  await browser.close();

  const buf = Buffer.from(pdfBuffer);
  assert(buf.length > 10000, `PDF size: ${buf.length} bytes`);

  // Check PDF magic bytes
  const header = buf.slice(0, 5).toString();
  assert(header === '%PDF-', `valid PDF header: ${header}`);

  // Save locally for review
  const fs = require('fs');
  const path = require('path');
  const outDir = path.join(__dirname, 'reports');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'test-report-ERF12345.pdf');
  fs.writeFileSync(outPath, pdfBuffer);
  console.log(`\n  PDF saved for review: ${outPath}`);
  console.log(`  PDF size: ${Math.round(pdfBuffer.length / 1024)} KB`);
}

// ─── Run all tests ─────────────────────────────────────────────────────

async function run() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  SUREPATH SYNTHESIS + PDF TESTS              ║');
  console.log('╚══════════════════════════════════════════════╝');

  console.log(`\nEnvironment:`);
  console.log(`  ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? 'SET' : 'NOT SET'}`);
  console.log(`  DATABASE_URL:     ${process.env.DATABASE_URL ? 'SET' : 'NOT SET'}`);
  console.log(`  AWS_S3_BUCKET:    ${process.env.AWS_S3_BUCKET ? 'SET' : 'NOT SET'}`);

  // Unit tests (always run)
  await testClassifyEra();
  await testAgeRiskMatrix();
  await testSuburbIntel();
  await testBuildHTML();

  // Offline PDF render (Puppeteer only, no DB)
  await testPdfRenderOffline();

  // Live tests (need DB + API)
  let reportId = null;
  if (process.env.DATABASE_URL && process.env.ANTHROPIC_API_KEY) {
    reportId = await testSynthesisLive();
  }
  if (process.env.DATABASE_URL && reportId) {
    await testPdfRenderLive(reportId);
  }

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
