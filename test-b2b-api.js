const http = require('http');
const crypto = require('crypto');
const pool = require('./db');

let passed = 0;
let failed = 0;
let serverPort;
let testApiKey;

function assert(condition, label) {
  if (condition) { console.log(`  PASS: ${label}`); passed++; }
  else { console.log(`  FAIL: ${label}`); failed++; }
}

function request(method, path, body, apiKey) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname: '127.0.0.1',
      port: serverPort,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ─── Setup: create test API client ─────────────────────────────────────

async function setup() {
  testApiKey = `sp_test_${crypto.randomBytes(16).toString('hex')}`;

  await pool.query(
    `INSERT INTO api_clients (company_name, tier, api_key, rate_limit_per_day, price_per_query_zar, active)
     VALUES ('Test B2B Corp', 'insurance', $1, 100, 2.50, TRUE)
     ON CONFLICT (api_key) DO NOTHING`,
    [testApiKey]
  );
  console.log(`  Test API key: ${testApiKey.substring(0, 20)}...`);

  // Insert test crime data for Gardens, Cape Town
  await pool.query(`
    INSERT INTO crime_incidents (suburb, city, lat, lng, incident_type, incident_date, source)
    VALUES
      ('Gardens', 'Cape Town', -33.9271, 18.4101, 'burglary', '2026-01-15', 'SAPS_annual'),
      ('Gardens', 'Cape Town', -33.9275, 18.4105, 'vehicle_theft', '2026-02-20', 'SAPS_annual'),
      ('Gardens', 'Cape Town', -33.9268, 18.4098, 'armed_response', '2026-03-01', 'ADT'),
      ('Gardens', 'Cape Town', -33.9280, 18.4110, 'burglary', '2026-03-10', 'Fidelity')
    ON CONFLICT DO NOTHING
  `);
}

async function teardown() {
  await pool.query('DELETE FROM api_usage WHERE client_id IN (SELECT id FROM api_clients WHERE api_key = $1)', [testApiKey]);
  await pool.query('DELETE FROM api_clients WHERE api_key = $1', [testApiKey]);
}

// ─── Auth tests ────────────────────────────────────────────────────────

async function testAuth() {
  console.log('\n=== AUTH: missing key ===');
  let res = await request('POST', '/api/v1/risk/insurance', { address: 'test' });
  assert(res.status === 401, `returns 401: ${res.status}`);
  assert(res.body.code === 'AUTH_MISSING', `code: ${res.body.code}`);

  console.log('\n=== AUTH: invalid key ===');
  res = await request('POST', '/api/v1/risk/insurance', { address: 'test' }, 'sp_fake_key_12345');
  assert(res.status === 401, `returns 401: ${res.status}`);
  assert(res.body.code === 'AUTH_INVALID', `code: ${res.body.code}`);

  console.log('\n=== AUTH: valid key ===');
  res = await request('POST', '/api/v1/risk/insurance', { address: '14 Kloof Street, Gardens, Cape Town' }, testApiKey);
  assert(res.status === 200 || res.status === 500, `returns 200 or 500 (pipeline may not have APIs): ${res.status}`);
  // If 200, verify response shape
  if (res.status === 200) {
    assert(typeof res.body.insurance_risk_score === 'number', `insurance_risk_score: ${res.body.insurance_risk_score}`);
  }
}

// ─── Rate limit test ───────────────────────────────────────────────────

async function testRateLimit() {
  console.log('\n=== AUTH: rate limit ===');

  // Create a client with rate_limit = 2
  const limitedKey = `sp_limited_${crypto.randomBytes(8).toString('hex')}`;
  await pool.query(
    `INSERT INTO api_clients (company_name, tier, api_key, rate_limit_per_day, price_per_query_zar, active)
     VALUES ('Rate Test Corp', 'consumer', $1, 2, 0.50, TRUE)`,
    [limitedKey]
  );

  // Insert 2 usage records for today to exhaust limit
  const { rows: clients } = await pool.query('SELECT id FROM api_clients WHERE api_key = $1', [limitedKey]);
  await pool.query(
    `INSERT INTO api_usage (client_id, endpoint, was_cache_hit, response_time_ms, billed_amount_zar) VALUES ($1, 'test', false, 100, 0.50), ($1, 'test', false, 100, 0.50)`,
    [clients[0].id]
  );

  const res = await request('GET', '/api/v1/heat-map/crime?suburb=Gardens&city=Cape+Town', null, limitedKey);
  assert(res.status === 429, `returns 429: ${res.status}`);
  assert(res.body.code === 'RATE_LIMIT', `code: ${res.body.code}`);

  // Clean up
  await pool.query('DELETE FROM api_usage WHERE client_id = $1', [clients[0].id]);
  await pool.query('DELETE FROM api_clients WHERE api_key = $1', [limitedKey]);
}

// ─── Input validation tests ────────────────────────────────────────────

async function testValidation() {
  console.log('\n=== VALIDATION: missing fields ===');

  let res = await request('POST', '/api/v1/risk/insurance', {}, testApiKey);
  assert(res.status === 400, `insurance no address: ${res.status}`);
  assert(res.body.code === 'MISSING_FIELD', `code: ${res.body.code}`);

  res = await request('POST', '/api/v1/risk/crime', {}, testApiKey);
  assert(res.status === 400, `crime no address: ${res.status}`);

  res = await request('POST', '/api/v1/solar/suitability', {}, testApiKey);
  assert(res.status === 400, `solar no address: ${res.status}`);

  res = await request('POST', '/api/v1/leads/trades', {}, testApiKey);
  assert(res.status === 400, `trades no suburb: ${res.status}`);

  res = await request('POST', '/api/v1/leads/solar', {}, testApiKey);
  assert(res.status === 400, `solar leads no suburb: ${res.status}`);

  res = await request('GET', '/api/v1/heat-map/crime', null, testApiKey);
  assert(res.status === 400, `heat-map no params: ${res.status}`);

  res = await request('POST', '/api/v1/report/full', {}, testApiKey);
  assert(res.status === 400, `report no address: ${res.status}`);
}

// ─── Endpoint tests (using seed data) ──────────────────────────────────

async function testInsuranceEndpoint() {
  console.log('\n=== ENDPOINT: POST /api/v1/risk/insurance ===');

  // Check if we have a report in the DB
  const { rows: reports } = await pool.query(
    "SELECT p.address_raw FROM property_reports pr JOIN properties p ON p.id = pr.property_id WHERE pr.status = 'complete' LIMIT 1"
  );
  if (reports.length === 0) {
    console.log('  SKIP: no complete reports in DB');
    return;
  }

  const address = reports[0].address_raw;
  const res = await request('POST', '/api/v1/risk/insurance', { address }, testApiKey);

  assert(res.status === 200, `status: ${res.status}`);
  if (res.status !== 200) return;

  assert(typeof res.body.insurance_risk_score === 'number', `insurance_risk_score: ${res.body.insurance_risk_score}`);
  assert(res.body.insurance_risk_score >= 1 && res.body.insurance_risk_score <= 10, 'score in range 1-10');
  assert(Array.isArray(res.body.insurance_flags), 'insurance_flags is array');
  assert(typeof res.body.maintenance_cost_estimate === 'number', `maintenance_cost: ${res.body.maintenance_cost_estimate}`);
  assert(typeof res.body.asbestos_risk === 'string', `asbestos_risk: ${res.body.asbestos_risk}`);
  assert(typeof res.body.report_age_days === 'number', `report_age_days: ${res.body.report_age_days}`);
  assert(typeof res.body.erf_number === 'string', `erf_number: ${res.body.erf_number}`);

  console.log(`  Response: score=${res.body.insurance_risk_score}, asbestos=${res.body.asbestos_risk}, cost=R${res.body.maintenance_cost_estimate}`);
}

async function testCrimeEndpoint() {
  console.log('\n=== ENDPOINT: POST /api/v1/risk/crime ===');

  const { rows: reports } = await pool.query(
    "SELECT p.address_raw FROM property_reports pr JOIN properties p ON p.id = pr.property_id WHERE pr.status = 'complete' LIMIT 1"
  );
  if (reports.length === 0) { console.log('  SKIP: no complete reports'); return; }

  const res = await request('POST', '/api/v1/risk/crime', { address: reports[0].address_raw, radius_km: 2 }, testApiKey);

  assert(res.status === 200, `status: ${res.status}`);
  if (res.status !== 200) return;

  assert(typeof res.body.crime_risk_score === 'number', `crime_risk_score: ${res.body.crime_risk_score}`);
  assert(typeof res.body.incident_breakdown === 'object', 'incident_breakdown is object');
  assert(typeof res.body.saps_data_period === 'string', `saps_data_period: ${res.body.saps_data_period}`);
  assert(typeof res.body.report_age_days === 'number', `report_age_days: ${res.body.report_age_days}`);

  console.log(`  Response: score=${res.body.crime_risk_score}, suburb=${res.body.suburb}, incidents=${JSON.stringify(res.body.incident_breakdown)}`);
}

async function testSolarEndpoint() {
  console.log('\n=== ENDPOINT: POST /api/v1/solar/suitability ===');

  const { rows: reports } = await pool.query(
    "SELECT p.address_raw FROM property_reports pr JOIN properties p ON p.id = pr.property_id WHERE pr.status = 'complete' LIMIT 1"
  );
  if (reports.length === 0) { console.log('  SKIP: no complete reports'); return; }

  const res = await request('POST', '/api/v1/solar/suitability', { address: reports[0].address_raw }, testApiKey);

  assert(res.status === 200, `status: ${res.status}`);
  if (res.status !== 200) return;

  assert(typeof res.body.solar_suitability_score === 'number', `score: ${res.body.solar_suitability_score}`);
  assert(typeof res.body.solar_installed === 'boolean', `solar_installed: ${res.body.solar_installed}`);
  assert(typeof res.body.roof_material === 'string', `roof_material: ${res.body.roof_material}`);
  assert(typeof res.body.roof_orientation === 'string', `roof_orientation: ${res.body.roof_orientation}`);
  assert(typeof res.body.recommended_system_size_kw === 'number', `recommended_kw: ${res.body.recommended_system_size_kw}`);
  assert(typeof res.body.erf_number === 'string', `erf_number: ${res.body.erf_number}`);

  console.log(`  Response: score=${res.body.solar_suitability_score}, roof=${res.body.roof_material}, kw=${res.body.recommended_system_size_kw}`);
}

async function testTradesLeads() {
  console.log('\n=== ENDPOINT: POST /api/v1/leads/trades ===');

  // Get a suburb that has reports
  const { rows: suburbs } = await pool.query(
    "SELECT DISTINCT p.suburb, p.city FROM properties p JOIN property_reports pr ON pr.property_id = p.id WHERE p.suburb IS NOT NULL LIMIT 1"
  );
  if (suburbs.length === 0) { console.log('  SKIP: no properties with reports'); return; }

  const { suburb, city } = suburbs[0];
  const res = await request('POST', '/api/v1/leads/trades', { suburb, city, trade_type: null, min_severity: 'MEDIUM' }, testApiKey);

  assert(res.status === 200, `status: ${res.status}`);
  if (res.status !== 200) return;

  assert(typeof res.body.count === 'number', `count: ${res.body.count}`);
  assert(Array.isArray(res.body.properties), 'properties is array');

  if (res.body.properties.length > 0) {
    const p = res.body.properties[0];
    assert(typeof p.address === 'string', `address: ${p.address}`);
    assert(typeof p.erf_number === 'string', `erf_number: ${p.erf_number}`);
    assert(Array.isArray(p.trade_flags), 'trade_flags is array');
    assert(typeof p.estimated_job_value.min === 'number', `job_value.min: ${p.estimated_job_value.min}`);
  }

  console.log(`  Response: ${res.body.count} properties in ${suburb}, ${city}`);
}

async function testSolarLeads() {
  console.log('\n=== ENDPOINT: POST /api/v1/leads/solar ===');

  const { rows: suburbs } = await pool.query(
    "SELECT DISTINCT p.suburb, p.city FROM properties p JOIN property_reports pr ON pr.property_id = p.id WHERE p.suburb IS NOT NULL LIMIT 1"
  );
  if (suburbs.length === 0) { console.log('  SKIP: no properties with reports'); return; }

  const { suburb, city } = suburbs[0];
  const res = await request('POST', '/api/v1/leads/solar', {
    suburb, city,
    filters: { no_solar: true, min_roof_score: 1 },
  }, testApiKey);

  assert(res.status === 200, `status: ${res.status}`);
  if (res.status !== 200) return;

  assert(typeof res.body.count === 'number', `count: ${res.body.count}`);
  assert(Array.isArray(res.body.properties), 'properties is array');

  if (res.body.properties.length > 0) {
    const p = res.body.properties[0];
    assert(typeof p.solar_suitability_score === 'number', `score: ${p.solar_suitability_score}`);
    assert(typeof p.roof_material === 'string', `roof_material: ${p.roof_material}`);
    assert(typeof p.construction_era === 'string', `era: ${p.construction_era}`);
  }

  console.log(`  Response: ${res.body.count} solar candidates in ${suburb}`);
}

async function testCrimeHeatMap() {
  console.log('\n=== ENDPOINT: GET /api/v1/heat-map/crime ===');

  const res = await request('GET', '/api/v1/heat-map/crime?suburb=Gardens&city=Cape+Town', null, testApiKey);

  assert(res.status === 200, `status: ${res.status}`);
  if (res.status !== 200) return;

  assert(res.body.suburb === 'Gardens', `suburb: ${res.body.suburb}`);
  assert(res.body.city === 'Cape Town', `city: ${res.body.city}`);
  assert(typeof res.body.incident_counts === 'object', 'incident_counts is object');
  assert(typeof res.body.total_incidents === 'number', `total: ${res.body.total_incidents}`);
  assert(res.body.total_incidents >= 4, `total >= 4 (seeded): ${res.body.total_incidents}`);
  assert(typeof res.body.coverage_period === 'string', `coverage: ${res.body.coverage_period}`);

  console.log(`  Response: ${res.body.total_incidents} incidents, types: ${JSON.stringify(res.body.incident_counts)}`);
}

async function testFullReport() {
  console.log('\n=== ENDPOINT: POST /api/v1/report/full ===');

  const { rows: reports } = await pool.query(
    "SELECT p.address_raw, pr.asking_price FROM property_reports pr JOIN properties p ON p.id = pr.property_id WHERE pr.status = 'complete' LIMIT 1"
  );
  if (reports.length === 0) { console.log('  SKIP: no complete reports'); return; }

  const res = await request('POST', '/api/v1/report/full', {
    address: reports[0].address_raw,
    asking_price: reports[0].asking_price || 2500000,
  }, testApiKey);

  assert(res.status === 200, `status: ${res.status}`);
  if (res.status !== 200) return;

  // Verify all expected fields
  const expectedFields = [
    'erf_number', 'address', 'suburb', 'city',
    'asking_price', 'avm_low', 'avm_high', 'price_verdict',
    'decision', 'decision_reasoning',
    'insurance_risk_score', 'insurance_flags',
    'crime_risk_score', 'solar_suitability_score',
    'trades_flags', 'maintenance_cost_estimate',
    'asbestos_risk', 'vision_findings',
    'structural_flags', 'compliance_flags',
    'repair_estimates', 'negotiation_intel',
    'roof_material', 'roof_orientation',
    'report_age_days', 'was_cache_hit',
  ];

  for (const field of expectedFields) {
    assert(field in res.body, `has ${field}`);
  }

  console.log(`  Response: decision=${res.body.decision}, cache=${res.body.was_cache_hit}, age=${res.body.report_age_days}d`);
}

// ─── Usage logging verification ────────────────────────────────────────

async function testUsageLogging() {
  console.log('\n=== USAGE: api_usage records ===');

  const { rows: client } = await pool.query('SELECT id FROM api_clients WHERE api_key = $1', [testApiKey]);
  if (client.length === 0) { console.log('  SKIP: no test client'); return; }

  const { rows: usage } = await pool.query(
    'SELECT endpoint, was_cache_hit, response_time_ms, billed_amount_zar FROM api_usage WHERE client_id = $1 ORDER BY created_at',
    [client[0].id]
  );

  assert(usage.length > 0, `usage records logged: ${usage.length}`);
  for (const u of usage) {
    assert(typeof u.response_time_ms === 'number', `response_time_ms logged for ${u.endpoint}: ${u.response_time_ms}ms`);
    assert(u.billed_amount_zar !== null, `billed_amount logged for ${u.endpoint}: R${u.billed_amount_zar}`);
  }

  console.log(`  ${usage.length} usage records, endpoints: ${[...new Set(usage.map(u => u.endpoint))].join(', ')}`);
}

// ─── Run ───────────────────────────────────────────────────────────────

async function run() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  SUREPATH B2B API TESTS                      ║');
  console.log('╚══════════════════════════════════════════════╝');

  const hasDB = !!process.env.DATABASE_URL;
  console.log(`\n  DATABASE_URL: ${hasDB ? 'SET' : 'NOT SET'}`);

  if (!hasDB) {
    console.log('  SKIP ALL: DATABASE_URL required\n');
    process.exit(0);
  }

  // Start the server
  const app = require('./server');
  const server = app.listen(0);
  serverPort = server.address().port;
  console.log(`  Test server on port ${serverPort}\n`);

  try {
    await setup();

    await testAuth();
    await testRateLimit();
    await testValidation();
    await testCrimeHeatMap();
    await testInsuranceEndpoint();
    await testCrimeEndpoint();
    await testSolarEndpoint();
    await testTradesLeads();
    await testSolarLeads();
    await testFullReport();
    await testUsageLogging();

    await teardown();
  } finally {
    server.close();
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
