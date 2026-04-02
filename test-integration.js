const pool = require('./db');
const windeed = require('./windeed');
const maps = require('./maps');

const TEST_ADDRESS = '12 Kloof Street, Gardens, Cape Town';

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

// ─── Windeed module tests (unit-level, no live API needed) ─────────────

async function testWindeedNormalise() {
  console.log('\n=== WINDEED: normaliseWindeedResponse ===');

  const mockRaw = {
    erf_number: 'ERF99999',
    registered_owner: 'John Smith',
    title_deed: 'T12345/2020',
    municipal_valuation: 2500000,
    transfer_history: [
      { date: '2020-03-15', price: 2200000, buyer: 'John Smith', seller: 'Jane Doe', bond: 1800000 },
      { date: '2015-06-01', price: 1600000, buyer: 'Jane Doe', seller: 'Bob Brown', bond: 1200000 },
    ],
  };

  const result = windeed.normaliseWindeedResponse(mockRaw);

  assert(result !== null, 'returns a result');
  assert(result.erf_number === 'ERF99999', 'erf_number mapped correctly');
  assert(result.registered_owner === 'John Smith', 'registered_owner mapped correctly');
  assert(result.title_deed_ref === 'T12345/2020', 'title_deed_ref mapped correctly');
  assert(result.municipal_value === 2500000, 'municipal_value mapped correctly');
  assert(Array.isArray(result.transfer_history), 'transfer_history is array');
  assert(result.transfer_history.length === 2, 'transfer_history has 2 entries');
  assert(result.transfer_history[0].buyer === 'John Smith', 'transfer_history[0].buyer correct');
  assert(result.transfer_history[0].bond === 1800000, 'transfer_history[0].bond correct');
}

async function testWindeedNormaliseNull() {
  console.log('\n=== WINDEED: normaliseWindeedResponse (null input) ===');
  const result = windeed.normaliseWindeedResponse(null);
  assert(result === null, 'returns null for null input');
}

async function testWindeedNormaliseAltFields() {
  console.log('\n=== WINDEED: normaliseWindeedResponse (alternative field names) ===');

  const mockRaw = {
    erfNumber: 'ERF88888',
    owner: 'Thabo Mbeki',
    titleDeed: 'T67890/2018',
    municipalValue: 1800000,
    transfers: [
      { transfer_date: '2018-01-10', purchase_price: 1800000, purchaser: 'Thabo Mbeki', transferor: 'Sipho Nkosi', bond_amount: 1500000 },
    ],
  };

  const result = windeed.normaliseWindeedResponse(mockRaw);

  assert(result.erf_number === 'ERF88888', 'erfNumber alt field mapped');
  assert(result.registered_owner === 'Thabo Mbeki', 'owner alt field mapped');
  assert(result.title_deed_ref === 'T67890/2018', 'titleDeed alt field mapped');
  assert(result.municipal_value === 1800000, 'municipalValue alt field mapped');
  assert(result.transfer_history[0].date === '2018-01-10', 'transfer_date alt field mapped');
  assert(result.transfer_history[0].price === 1800000, 'purchase_price alt field mapped');
}

async function testWindeedFindOrCreate() {
  console.log('\n=== WINDEED: findOrCreateProperty (DB) ===');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Create
    const id1 = await windeed.findOrCreateProperty('ERF_TEST_001', TEST_ADDRESS);
    assert(typeof id1 === 'number', 'creates property and returns numeric id');

    // Find existing
    const id2 = await windeed.findOrCreateProperty('ERF_TEST_001', TEST_ADDRESS);
    assert(id1 === id2, 'returns same id for existing erf_number');

    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
}

async function testWindeedDbPipeline() {
  console.log('\n=== WINDEED: full DB pipeline (mocked API response) ===');

  // We can't call the live API without a key, but we can test the DB pipeline
  // by calling findOrCreateProperty + inserting deeds_data directly
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const propertyId = await windeed.findOrCreateProperty('ERF_PIPELINE_TEST', TEST_ADDRESS);
    assert(typeof propertyId === 'number', 'property created');

    // Insert deeds_data as the pipeline would
    const { rows } = await client.query(
      `INSERT INTO deeds_data (property_id, registered_owner, title_deed_ref,
         municipal_value, transfer_history, raw_windeed_response)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        propertyId,
        'Test Owner',
        'T00001/2024',
        3200000,
        JSON.stringify([{ date: '2024-01-15', price: 3200000, buyer: 'Test Owner', seller: 'Prev Owner', bond: 2500000 }]),
        JSON.stringify({ mock: true }),
      ]
    );

    assert(typeof rows[0].id === 'number', 'deeds_data inserted with FK to property');

    // Verify FK integrity
    const { rows: joined } = await client.query(
      `SELECT p.erf_number, d.registered_owner, d.municipal_value
       FROM deeds_data d JOIN properties p ON p.id = d.property_id
       WHERE d.id = $1`,
      [rows[0].id]
    );
    assert(joined[0].erf_number === 'ERF_PIPELINE_TEST', 'FK join returns correct property');
    assert(joined[0].registered_owner === 'Test Owner', 'deeds_data fields stored correctly');
    assert(joined[0].municipal_value === 3200000, 'municipal_value stored correctly');

    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
}

// ─── Maps module tests ─────────────────────────────────────────────────

async function testMapsGeocode() {
  console.log('\n=== MAPS: geocode (live API) ===');

  if (!process.env.GOOGLE_MAPS_API_KEY) {
    console.log('  SKIP: GOOGLE_MAPS_API_KEY not set');
    return;
  }

  const result = await maps.geocode(TEST_ADDRESS);

  assert(result !== null, 'geocode returns a result');
  if (!result) return;

  assert(typeof result.lat === 'number', `lat is number: ${result.lat}`);
  assert(typeof result.lng === 'number', `lng is number: ${result.lng}`);
  assert(result.lat < -33 && result.lat > -35, `lat in Cape Town range: ${result.lat}`);
  assert(result.lng > 18 && result.lng < 19, `lng in Cape Town range: ${result.lng}`);
  assert(typeof result.formatted_address === 'string', `formatted_address: ${result.formatted_address}`);
  assert(result.city !== null, `city: ${result.city}`);
  assert(result.province !== null, `province: ${result.province}`);
}

async function testMapsStreetView() {
  console.log('\n=== MAPS: getStreetView (live API) ===');

  if (!process.env.GOOGLE_MAPS_API_KEY) {
    console.log('  SKIP: GOOGLE_MAPS_API_KEY not set');
    return;
  }

  // Cape Town CBD coordinates
  const base64 = await maps.getStreetView(-33.9271, 18.4101);

  assert(base64 !== null, 'returns base64 string');
  if (!base64) return;

  assert(typeof base64 === 'string', 'result is a string');
  assert(base64.length > 1000, `base64 length reasonable: ${base64.length} chars`);

  // Verify it's valid base64 by decoding
  const buffer = Buffer.from(base64, 'base64');
  assert(buffer.length > 500, `decoded buffer size: ${buffer.length} bytes`);
}

async function testMapsSatelliteView() {
  console.log('\n=== MAPS: getSatelliteView (live API) ===');

  if (!process.env.GOOGLE_MAPS_API_KEY) {
    console.log('  SKIP: GOOGLE_MAPS_API_KEY not set');
    return;
  }

  const base64 = await maps.getSatelliteView(-33.9271, 18.4101);

  assert(base64 !== null, 'returns base64 string');
  if (!base64) return;

  assert(typeof base64 === 'string', 'result is a string');
  assert(base64.length > 1000, `base64 length reasonable: ${base64.length} chars`);
}

async function testMapsFullPipeline() {
  console.log('\n=== MAPS: full lookupAddress pipeline (live API + DB) ===');

  if (!process.env.GOOGLE_MAPS_API_KEY) {
    console.log('  SKIP: GOOGLE_MAPS_API_KEY not set');
    return;
  }
  if (!process.env.DATABASE_URL) {
    console.log('  SKIP: DATABASE_URL not set');
    return;
  }

  // Create a test property first
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `INSERT INTO properties (erf_number, address_raw)
       VALUES ('ERF_MAPS_TEST', $1)
       RETURNING id`,
      [TEST_ADDRESS]
    );
    const propertyId = rows[0].id;

    await client.query('COMMIT');

    // Run the full pipeline
    const result = await maps.lookupAddress(TEST_ADDRESS, propertyId);

    assert(result !== null, 'lookupAddress returns a result');
    if (!result) return;

    assert(result.geocode !== null, 'geocode data present');
    assert(result.geocode.lat < -33, `lat in range: ${result.geocode.lat}`);
    assert(result.streetview_base64 !== null, 'streetview image returned');
    assert(result.satellite_base64 !== null, 'satellite image returned');
    assert(typeof result.streetview_image_id === 'number', `streetview stored in DB: image id ${result.streetview_image_id}`);
    assert(typeof result.satellite_image_id === 'number', `satellite stored in DB: image id ${result.satellite_image_id}`);

    // Verify DB records
    const { rows: images } = await client.query(
      'SELECT source, image_type FROM property_images WHERE property_id = $1 ORDER BY source',
      [propertyId]
    );
    assert(images.length === 2, `2 images stored in property_images`);
    assert(images.some(i => i.source === 'streetview'), 'streetview image record exists');
    assert(images.some(i => i.source === 'satellite'), 'satellite image record exists');

    // Verify property was updated with geocoded data
    const { rows: props } = await client.query(
      'SELECT lat, lng, address_normalised, suburb, city, province FROM properties WHERE id = $1',
      [propertyId]
    );
    assert(props[0].lat !== null, `property lat updated: ${props[0].lat}`);
    assert(props[0].lng !== null, `property lng updated: ${props[0].lng}`);
    assert(props[0].address_normalised !== null, `address normalised: ${props[0].address_normalised}`);

    // Clean up
    await client.query('BEGIN');
    await client.query('DELETE FROM property_images WHERE property_id = $1', [propertyId]);
    await client.query('DELETE FROM properties WHERE id = $1', [propertyId]);
    await client.query('COMMIT');
  } finally {
    client.release();
  }
}

// ─── Run all tests ─────────────────────────────────────────────────────

async function run() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  SUREPATH INTEGRATION TESTS                  ║');
  console.log('║  Test address: ' + TEST_ADDRESS.padEnd(30) + '║');
  console.log('╚══════════════════════════════════════════════╝');

  const hasDb = !!process.env.DATABASE_URL;
  const hasGoogle = !!process.env.GOOGLE_MAPS_API_KEY;
  const hasWindeed = !!process.env.WINDEED_API_KEY;

  console.log(`\nEnvironment:`);
  console.log(`  DATABASE_URL:        ${hasDb ? 'SET' : 'NOT SET'}`);
  console.log(`  GOOGLE_MAPS_API_KEY: ${hasGoogle ? 'SET' : 'NOT SET'}`);
  console.log(`  WINDEED_API_KEY:     ${hasWindeed ? 'SET' : 'NOT SET'}`);

  // Windeed tests (no live API needed for most)
  await testWindeedNormalise();
  await testWindeedNormaliseNull();
  await testWindeedNormaliseAltFields();

  if (hasDb) {
    await testWindeedFindOrCreate();
    await testWindeedDbPipeline();
  } else {
    console.log('\n  SKIP: Windeed DB tests (DATABASE_URL not set)');
  }

  // Maps tests
  await testMapsGeocode();
  await testMapsStreetView();
  await testMapsSatelliteView();
  await testMapsFullPipeline();

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
