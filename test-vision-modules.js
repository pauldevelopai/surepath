#!/usr/bin/env node
/**
 * Test harness for all vision specialist modules.
 * Validates that functions load, accept input, and return correct JSON schema.
 *
 * Usage: node test-vision-modules.js
 *
 * Does NOT require a database — mocks pool.query.
 * Uses a test image downloaded from the web.
 */

require('dotenv').config();

// Mock pool.query before loading vision.js
const realDb = require('./db');
const originalQuery = realDb.query.bind(realDb);
realDb.query = async (...args) => {
  // Return empty results for any DB call
  return { rows: [], rowCount: 0 };
};

const vision = require('./vision');

const ALLOWED_SEVERITIES = new Set(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'COSMETIC']);
const ALLOWED_CONFIDENCES = new Set(['CONFIRMED_VISIBLE', 'PROBABLE', 'POSSIBLE', 'NOT_DETECTABLE']);

let totalTests = 0;
let passed = 0;
let failed = 0;

function check(name, condition, reason) {
  totalTests++;
  if (condition) {
    passed++;
    console.log(`  ✓ PASS: ${name}`);
  } else {
    failed++;
    console.log(`  ✗ FAIL: ${name} — ${reason}`);
  }
}

async function getTestImage() {
  console.log('Downloading test image...');
  try {
    const buffer = await vision.downloadImage('https://upload.wikimedia.org/wikipedia/commons/thumb/f/f9/Phoenixville_Blob_House.jpg/640px-Phoenixville_Blob_House.jpg');
    if (buffer.length > 1000) {
      console.log(`  Test image: ${buffer.length} bytes`);
      return buffer.toString('base64');
    }
  } catch {}

  // Fallback: tiny test image
  console.log('  Using minimal test image (web download failed)');
  // 1x1 white JPEG
  return '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYI4Q/SFhSRJFEoB2UkZSJgUm1wQkKdg==';
}

async function testFunction(name, fn, specialistKey) {
  console.log(`\n─── Testing ${name} ───`);
  const base64 = await getTestImage();

  try {
    const result = await fn(base64);

    check(`${name} returns object`, typeof result === 'object' && result !== null, 'returned non-object');
    check(`${name} has photo_type`, typeof result.photo_type === 'string', `photo_type: ${typeof result.photo_type}`);
    check(`${name} has findings array`, Array.isArray(result.findings), `findings: ${typeof result.findings}`);

    if (specialistKey) {
      check(`${name} has ${specialistKey} object`, typeof result[specialistKey] === 'object', `${specialistKey}: ${typeof result[specialistKey]}`);
    }

    if (Array.isArray(result.findings) && result.findings.length > 0) {
      check(`${name} findings have severity`, result.findings.every(f => ALLOWED_SEVERITIES.has(f.severity)),
        `invalid severity: ${result.findings.map(f => f.severity).join(', ')}`);
      check(`${name} findings have confidence`, result.findings.every(f => ALLOWED_CONFIDENCES.has(f.confidence)),
        `invalid confidence: ${result.findings.map(f => f.confidence).join(', ')}`);
      check(`${name} findings have observation`, result.findings.every(f => typeof f.observation === 'string'),
        'missing observation string');
    } else {
      check(`${name} has at least one finding`, result.findings?.length > 0, 'empty findings array (may be valid for test image)');
    }

    console.log(`  Result preview: ${JSON.stringify(result).substring(0, 200)}...`);

  } catch (err) {
    check(`${name} executes without error`, false, err.message);
  }
}

async function main() {
  console.log('═══ SUREPATH VISION MODULES TEST HARNESS ═══\n');

  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('WARNING: ANTHROPIC_API_KEY not set — specialist functions will fail.');
    console.log('Set it in .env to run full tests.\n');
  }

  // Test module loading
  console.log('─── Module Loading ───');
  const functions = [
    'analyseDBBoard', 'analyseCeilingDeep', 'analyseExteriorSecurity',
    'analysePlumbing', 'analyseTemporalChange', 'analyseBatch',
    'analyseStreetView', 'analyseSatellite', 'aggregateFindings',
  ];
  for (const fn of functions) {
    check(`${fn} exported`, typeof vision[fn] === 'function', 'not a function');
  }

  // Only run live tests if API key is available
  if (process.env.ANTHROPIC_API_KEY) {
    await testFunction('analyseDBBoard', vision.analyseDBBoard, 'db_board');
    await testFunction('analyseCeilingDeep', vision.analyseCeilingDeep, 'ceiling');
    await testFunction('analyseExteriorSecurity', vision.analyseExteriorSecurity, 'security_assessment');
    await testFunction('analysePlumbing', vision.analysePlumbing, 'plumbing');

    // Test aggregateFindings with specialist data
    console.log('\n─── Testing aggregateFindings with specialist data ───');
    const mockAnalyses = [{
      photo_type: 'exterior',
      findings: [{ category: 'walls', observation: 'test crack', severity: 'HIGH', confidence: 'PROBABLE', relevant_to: ['consumer'] }],
      roof_material: 'IBR',
      solar_installed: false,
      asbestos_indicators: false,
      security_visible: true,
      security_assessment: { security_score: 6 },
      db_board: { overall_condition: 'POOR', visible_burn_marks: false, panel_type: 'semi_modern_mcb' },
      plumbing: { corrosion_level: 'none', geyser_visible: true, geyser_assessment: { approximate_age_condition: 'mid_life_5_10yr', drip_tray_visible: false } },
    }];

    const agg = vision.aggregateFindings(mockAnalyses);
    check('aggregateFindings returns security_score', agg.security_score !== undefined, 'missing security_score');
    check('aggregateFindings has compliance_flags from specialist', agg.compliance_flags.length > 0, 'no compliance flags generated');
    console.log(`  Security score: ${agg.security_score}`);
    console.log(`  Insurance risk: ${agg.insurance_risk_score}`);
    console.log(`  Compliance flags: ${agg.compliance_flags.length}`);
  } else {
    console.log('\nSkipping live API tests (no ANTHROPIC_API_KEY).\n');
  }

  // Summary
  console.log('\n═══ SUMMARY ═══');
  console.log(`  Total: ${totalTests}`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  ${failed === 0 ? '✓ ALL TESTS PASSED' : '✗ SOME TESTS FAILED'}`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Test harness error:', err);
  process.exit(1);
});
