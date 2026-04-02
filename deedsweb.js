/**
 * DeedsWeb Direct API — DRDLR (replaces Windeed reseller)
 *
 * Connects directly to the Chief Registrar of Deeds SOAP web service.
 * Registration: deedsweb.deeds.gov.za — R217 one-time, ~R18/query
 * Contact: 012 401 9323
 *
 * Until DRDLR credentials are configured, falls back to windeed.js automatically.
 */

const https = require('https');
const { URL } = require('url');
const pool = require('./db');

const DEEDSWEB_USERNAME = process.env.DEEDSWEB_USERNAME;
const DEEDSWEB_PASSWORD = process.env.DEEDSWEB_PASSWORD;
const DEEDSWEB_WSDL_URL = process.env.DEEDSWEB_WSDL_URL ||
  'https://deedsweb.deeds.gov.za/services/DeedsWebService?wsdl';
const DEEDSWEB_COST_PER_QUERY = parseFloat(process.env.DEEDSWEB_COST_PER_QUERY || '18');

// Extract the SOAP endpoint from the WSDL URL
const DEEDSWEB_ENDPOINT = DEEDSWEB_WSDL_URL.replace('?wsdl', '');

// ─── SOAP helper ────────────────────────────────────────────────────────

function buildSOAPEnvelope(action, bodyXml) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:deed="http://deeds.gov.za/deedsweb">
  <soapenv:Header>
    <deed:AuthHeader>
      <deed:Username>${DEEDSWEB_USERNAME}</deed:Username>
      <deed:Password>${DEEDSWEB_PASSWORD}</deed:Password>
    </deed:AuthHeader>
  </soapenv:Header>
  <soapenv:Body>
    <deed:${action}>
      ${bodyXml}
    </deed:${action}>
  </soapenv:Body>
</soapenv:Envelope>`;
}

function parseXMLValue(xml, tag) {
  const re = new RegExp(`<(?:[^:]+:)?${tag}[^>]*>([^<]*)</(?:[^:]+:)?${tag}>`, 'i');
  const match = xml.match(re);
  return match ? match[1].trim() : null;
}

function parseXMLArray(xml, wrapperTag, itemTag) {
  const items = [];
  const wrapperRe = new RegExp(`<(?:[^:]+:)?${wrapperTag}[^>]*>([\\s\\S]*?)</(?:[^:]+:)?${wrapperTag}>`, 'gi');
  let wrapperMatch;
  while ((wrapperMatch = wrapperRe.exec(xml))) {
    const itemRe = new RegExp(`<(?:[^:]+:)?${itemTag}[^>]*>([\\s\\S]*?)</(?:[^:]+:)?${itemTag}>`, 'gi');
    let itemMatch;
    while ((itemMatch = itemRe.exec(wrapperMatch[1]))) {
      items.push(itemMatch[1]);
    }
  }
  return items;
}

async function deedsWebRequest(action, xmlBody) {
  if (!DEEDSWEB_USERNAME || !DEEDSWEB_PASSWORD) {
    throw new Error('DeedsWeb credentials not configured');
  }

  const envelope = buildSOAPEnvelope(action, xmlBody);
  const url = new URL(DEEDSWEB_ENDPOINT);

  return new Promise((resolve, reject) => {
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml;charset=UTF-8',
        'SOAPAction': `"http://deeds.gov.za/deedsweb/${action}"`,
        'User-Agent': 'SurePath/1.0 PropertyIntelligence',
        'Content-Length': Buffer.byteLength(envelope),
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          const fault = parseXMLValue(body, 'faultstring');
          reject(new Error(`DeedsWeb ${res.statusCode}: ${fault || body.substring(0, 200)}`));
          return;
        }
        resolve(body);
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(envelope);
    req.end();
  });
}

// ─── Search functions ───────────────────────────────────────────────────

async function searchProperty(address) {
  if (!DEEDSWEB_USERNAME || !DEEDSWEB_PASSWORD) {
    console.warn('[deedsweb] Credentials not set — falling back to windeed.js');
    const windeedFallback = require('./windeed-legacy');
    return windeedFallback.searchProperty(address);
  }

  try {
    const xml = await deedsWebRequest('PropertySearch',
      `<deed:Address>${escapeXml(address)}</deed:Address>`);
    return normaliseDeedsWebResponse(xml);
  } catch (err) {
    console.error(`[deedsweb] Search error for "${address}":`, err.message);
    return null;
  }
}

async function searchByErf(erfNumber, township, deedsOffice) {
  if (!DEEDSWEB_USERNAME || !DEEDSWEB_PASSWORD) {
    return null;
  }

  try {
    const xml = await deedsWebRequest('ErfSearch', `
      <deed:ErfNumber>${escapeXml(erfNumber)}</deed:ErfNumber>
      <deed:Township>${escapeXml(township || '')}</deed:Township>
      <deed:DeedsOffice>${escapeXml(deedsOffice || '')}</deed:DeedsOffice>
    `);
    return normaliseDeedsWebResponse(xml);
  } catch (err) {
    console.error(`[deedsweb] ERF search error:`, err.message);
    return null;
  }
}

async function searchByLPI(lpiCode) {
  if (!DEEDSWEB_USERNAME || !DEEDSWEB_PASSWORD) {
    return null;
  }

  try {
    const xml = await deedsWebRequest('LPISearch',
      `<deed:LPICode>${escapeXml(lpiCode)}</deed:LPICode>`);
    return normaliseDeedsWebResponse(xml);
  } catch (err) {
    console.error(`[deedsweb] LPI search error:`, err.message);
    return null;
  }
}

async function getPropertyDeeds(erfNumber, township, deedsOffice) {
  if (!DEEDSWEB_USERNAME || !DEEDSWEB_PASSWORD) {
    return null;
  }

  try {
    const xml = await deedsWebRequest('PropertyDeeds', `
      <deed:ErfNumber>${escapeXml(erfNumber)}</deed:ErfNumber>
      <deed:Township>${escapeXml(township || '')}</deed:Township>
      <deed:DeedsOffice>${escapeXml(deedsOffice || '')}</deed:DeedsOffice>
    `);
    return normaliseDeedsWebResponse(xml);
  } catch (err) {
    console.error(`[deedsweb] Deeds error:`, err.message);
    return null;
  }
}

function escapeXml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Response normalisation ────────────────────────────────────────────

function normaliseDeedsWebResponse(rawXml) {
  if (!rawXml) return null;

  const erfNumber = parseXMLValue(rawXml, 'ErfNumber') || parseXMLValue(rawXml, 'erf_number');
  const lpiCode = parseXMLValue(rawXml, 'LPICode') || parseXMLValue(rawXml, 'LandParcelIdentifier');
  const registeredOwner = parseXMLValue(rawXml, 'RegisteredOwner') || parseXMLValue(rawXml, 'OwnerName');
  const ownerIdNumber = parseXMLValue(rawXml, 'OwnerIdNumber') || parseXMLValue(rawXml, 'IdentityNumber');
  const titleDeedRef = parseXMLValue(rawXml, 'TitleDeedReference') || parseXMLValue(rawXml, 'TitleDeed');
  const municipalValue = parseInt(parseXMLValue(rawXml, 'MunicipalValue') || '0') || null;
  const bondHolder = parseXMLValue(rawXml, 'BondHolder') || parseXMLValue(rawXml, 'Bondholder');
  const bondAmount = parseInt(parseXMLValue(rawXml, 'BondAmount') || '0') || null;
  const deedsOffice = parseXMLValue(rawXml, 'DeedsOffice');
  const extentSqm = parseInt(parseXMLValue(rawXml, 'Extent') || '0') || null;
  const township = parseXMLValue(rawXml, 'Township');
  const registrationDivision = parseXMLValue(rawXml, 'RegistrationDivision');

  // Transfer history
  const transferItems = parseXMLArray(rawXml, 'TransferHistory', 'Transfer');
  const transferHistory = transferItems.map(item => ({
    date: parseXMLValue(item, 'TransferDate') || parseXMLValue(item, 'RegistrationDate'),
    price: parseInt(parseXMLValue(item, 'PurchasePrice') || '0') || null,
    buyer: parseXMLValue(item, 'Buyer') || parseXMLValue(item, 'Purchaser'),
    seller: parseXMLValue(item, 'Seller') || parseXMLValue(item, 'Transferor'),
    bond: parseInt(parseXMLValue(item, 'BondAmount') || '0') || null,
  }));

  return {
    erf_number: erfNumber,
    lpi_code: lpiCode,
    registered_owner: registeredOwner,
    owner_id_number: ownerIdNumber,
    title_deed_ref: titleDeedRef,
    municipal_value: municipalValue,
    bond_holder: bondHolder,
    bond_amount: bondAmount,
    transfer_history: transferHistory,
    deeds_office: deedsOffice,
    extent_sqm: extentSqm,
    township,
    registration_division: registrationDivision,
  };
}

// ─── Cost logging ──────────────────────────────────────────────────────

async function logDeedsWebCost(action) {
  try {
    const { logCost } = require('./costs');
    await logCost('deedsweb', action, DEEDSWEB_COST_PER_QUERY / 18.5); // Convert ZAR to USD for consistency
  } catch {}
}

// ─── Main lookup — drop-in replacement for windeed.lookupAddress() ─────

async function findOrCreateProperty(erfNumber, addressRaw) {
  const { rows: existing } = await pool.query(
    'SELECT id FROM properties WHERE erf_number = $1', [erfNumber]
  );
  if (existing.length > 0) return existing[0].id;

  const { rows: created } = await pool.query(
    'INSERT INTO properties (erf_number, address_raw) VALUES ($1, $2) RETURNING id',
    [erfNumber, addressRaw]
  );
  return created[0].id;
}

async function lookupAddress(address) {
  // Credential guard — fall back to Windeed if DeedsWeb not configured
  if (!DEEDSWEB_USERNAME || !DEEDSWEB_PASSWORD) {
    console.warn('[deedsweb] Credentials not set — using windeed.js fallback');
    try {
      const windeedFallback = require('./windeed-legacy');
      return windeedFallback.lookupAddress(address);
    } catch {
      console.warn('[deedsweb] windeed-legacy.js not found either — returning null');
      return null;
    }
  }

  // Step 1: Search DeedsWeb
  const normalised = await searchProperty(address);
  if (!normalised || !normalised.erf_number) {
    console.error(`[deedsweb] No results for "${address}"`);
    return null;
  }

  // Step 2: Find or create property
  const propertyId = await findOrCreateProperty(normalised.erf_number, address);

  // Step 3: Store deeds data
  const { rows: deedsRows } = await pool.query(
    `INSERT INTO deeds_data (property_id, registered_owner, title_deed_ref,
       municipal_value, transfer_history, raw_deedsweb_response, lpi_code, deeds_office, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'deedsweb')
     RETURNING id`,
    [
      propertyId,
      normalised.registered_owner,
      normalised.title_deed_ref,
      normalised.municipal_value,
      JSON.stringify(normalised.transfer_history),
      JSON.stringify(normalised),
      normalised.lpi_code,
      normalised.deeds_office,
    ]
  );

  // Step 4: Update property with deeds-derived fields
  await pool.query(
    `UPDATE properties SET last_deeds_lookup = NOW(),
       lpi_code = COALESCE($1, lpi_code),
       owner_id_number = COALESCE($2, owner_id_number),
       bond_holder = COALESCE($3, bond_holder),
       bond_amount = COALESCE($4, bond_amount),
       stand_size_sqm = COALESCE($5, stand_size_sqm)
     WHERE id = $6`,
    [normalised.lpi_code, normalised.owner_id_number, normalised.bond_holder,
     normalised.bond_amount, normalised.extent_sqm, propertyId]
  );

  // Step 5: Log cost
  await logDeedsWebCost('property_lookup');

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
  searchByErf,
  searchByLPI,
  getPropertyDeeds,
  normaliseDeedsWebResponse,
  findOrCreateProperty,
  lookupAddress,
};
