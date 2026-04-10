// Priority: DeedsWeb (R18/query) > WinDeed Browser (R50+) > WinDeed REST API (legacy)
if (process.env.DEEDSWEB_USERNAME && process.env.DEEDSWEB_PASSWORD) {
  module.exports = require('./deedsweb');
  return;
}
if (process.env.WINDEED_USERNAME && process.env.WINDEED_PASSWORD) {
  module.exports = require('./windeed-browser');
  return;
}

const https = require('https');
const { URL } = require('url');
const pool = require('./db');

const WINDEED_API_KEY = process.env.WINDEED_API_KEY;
const WINDEED_BASE_URL = process.env.WINDEED_BASE_URL || 'https://www.windeed.co.za/api';

/**
 * Make an authenticated HTTPS request to the Windeed API.
 */
function windeedRequest(endpoint, params = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${WINDEED_BASE_URL}${endpoint}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${WINDEED_API_KEY}`,
        'Accept': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Windeed API ${res.statusCode}: ${body}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`Windeed API invalid JSON: ${body.substring(0, 200)}`));
        }
      });
      res.on('error', reject);
    });

    req.on('error', reject);
    req.end();
  });
}

/**
 * Search Windeed for a property by address.
 * Returns the raw API response or null on error.
 *
 * NOTE: Adjust the endpoint path and response field mappings below
 * once you have Windeed's actual API documentation. The structure
 * here follows common SA property data provider patterns.
 */
async function searchProperty(address) {
  if (!WINDEED_API_KEY) {
    console.error('WINDEED_API_KEY not set');
    return null;
  }

  try {
    const data = await windeedRequest('/property/search', { address });
    return data;
  } catch (err) {
    console.error(`Windeed search error for "${address}":`, err.message);
    return null;
  }
}

/**
 * Get detailed deeds data for a property by erf number.
 */
async function getPropertyDeeds(erfNumber) {
  if (!WINDEED_API_KEY) {
    console.error('WINDEED_API_KEY not set');
    return null;
  }

  try {
    const data = await windeedRequest('/property/deeds', { erf_number: erfNumber });
    return data;
  } catch (err) {
    console.error(`Windeed deeds error for "${erfNumber}":`, err.message);
    return null;
  }
}

/**
 * Normalise the raw Windeed API response into the fields we store.
 *
 * Adjust field mappings here when you get actual Windeed response samples.
 * Current mapping assumes:
 *   response.erf_number, response.registered_owner, response.title_deed,
 *   response.municipal_valuation, response.transfer_history[]
 */
function normaliseWindeedResponse(raw) {
  if (!raw) return null;

  // Map from Windeed response fields to our schema fields
  // Adjust these field names once you have a real API response sample
  const erfNumber = raw.erf_number || raw.erfNumber || raw.erf || null;
  const registeredOwner = raw.registered_owner || raw.owner || raw.registeredOwner || null;
  const titleDeedRef = raw.title_deed || raw.title_deed_ref || raw.titleDeed || null;
  const municipalValue = raw.municipal_valuation || raw.municipal_value || raw.municipalValue || null;

  // Transfer history — normalise to [{date, price, buyer, seller, bond}]
  let transferHistory = [];
  const rawTransfers = raw.transfer_history || raw.transfers || raw.transferHistory || [];
  if (Array.isArray(rawTransfers)) {
    transferHistory = rawTransfers.map((t) => ({
      date: t.date || t.transfer_date || t.registration_date || null,
      price: t.price || t.purchase_price || t.amount || null,
      buyer: t.buyer || t.purchaser || null,
      seller: t.seller || t.transferor || null,
      bond: t.bond || t.bond_amount || t.bondAmount || null,
    }));
  }

  return {
    erf_number: erfNumber,
    registered_owner: registeredOwner,
    title_deed_ref: titleDeedRef,
    municipal_value: municipalValue,
    transfer_history: transferHistory,
  };
}

/**
 * Find or create a property row by erf_number.
 * Returns the property id.
 */
async function findOrCreateProperty(erfNumber, addressRaw) {
  // Try to find existing
  const { rows: existing } = await pool.query(
    'SELECT id FROM properties WHERE erf_number = $1',
    [erfNumber]
  );

  if (existing.length > 0) {
    return existing[0].id;
  }

  // Create new property
  const { rows: created } = await pool.query(
    `INSERT INTO properties (erf_number, address_raw)
     VALUES ($1, $2)
     RETURNING id`,
    [erfNumber, addressRaw]
  );

  return created[0].id;
}

/**
 * Full Windeed lookup pipeline for an address:
 * 1. Search Windeed by address → get erf_number + deeds data
 * 2. Find or create property in our DB
 * 3. Store deeds_data linked to property
 * 4. Update property.last_deeds_lookup
 *
 * @param {string} address - Raw address string
 * @returns {{ property_id, erf_number, registered_owner, title_deed_ref,
 *             municipal_value, transfer_history, deeds_data_id } | null}
 */
async function lookupAddress(address) {
  // Step 1: Search Windeed
  const rawResponse = await searchProperty(address);
  if (!rawResponse) return null;

  // Step 2: Normalise
  const normalised = normaliseWindeedResponse(rawResponse);
  if (!normalised || !normalised.erf_number) {
    console.error(`Windeed returned no erf_number for "${address}"`);
    return null;
  }

  // Step 3: Find or create property
  const propertyId = await findOrCreateProperty(normalised.erf_number, address);

  // Step 4: Insert deeds_data
  const { rows: deedsRows } = await pool.query(
    `INSERT INTO deeds_data (property_id, registered_owner, title_deed_ref,
       municipal_value, transfer_history, raw_windeed_response)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      propertyId,
      normalised.registered_owner,
      normalised.title_deed_ref,
      normalised.municipal_value,
      JSON.stringify(normalised.transfer_history),
      JSON.stringify(rawResponse),
    ]
  );

  // Step 5: Update last_deeds_lookup on property
  await pool.query(
    'UPDATE properties SET last_deeds_lookup = NOW() WHERE id = $1',
    [propertyId]
  );

  return {
    property_id: propertyId,
    deeds_data_id: deedsRows[0].id,
    erf_number: normalised.erf_number,
    registered_owner: normalised.registered_owner,
    title_deed_ref: normalised.title_deed_ref,
    municipal_value: normalised.municipal_value,
    transfer_history: normalised.transfer_history,
  };
}

module.exports = {
  searchProperty,
  getPropertyDeeds,
  normaliseWindeedResponse,
  findOrCreateProperty,
  lookupAddress,
};
