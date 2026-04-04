/**
 * Data provenance tracking for Surepath.
 *
 * RULES:
 * 1. Every field stored MUST have a source record with an EXACT URL
 * 2. The URL must point to the specific page, document, or API response
 *    — NOT the homepage or generic documentation
 * 3. If you can't provide an exact URL, the confidence is "unverified"
 * 4. Every module that writes data must call recordSource()
 *
 * data_sources JSONB on properties table:
 * {
 *   "field_name": {
 *     "source": "property24_scrape",
 *     "name": "Property24 Listing",
 *     "url": "https://www.property24.com/for-sale/gardens/cape-town/western-cape/9145/117082090",
 *     "confidence": "scraped",
 *     "date": "2026-04-01T..."
 *   }
 * }
 *
 * Confidence levels:
 *   verified   — official API with audit trail (Google, Windeed, SAPS)
 *   scraped    — extracted from a specific web page (Property24 listing)
 *   estimated  — AI-generated (Claude) — indicator, not fact
 *   unverified — no exact source URL available — must be verified
 */

const pool = require('./db');

/**
 * Record the source of one or more fields for a property.
 *
 * @param {number} propertyId
 * @param {string} sourceName — human-readable name (e.g. "Property24 Listing")
 * @param {string} exactUrl — the EXACT page/document URL (not a homepage)
 * @param {string} confidence — "verified" | "scraped" | "estimated" | "unverified"
 * @param {string[]} fields — field names that came from this source
 */
async function recordSource(propertyId, sourceName, exactUrl, confidence, fields) {
  if (!exactUrl && confidence !== 'unverified') {
    console.warn(`[provenance] WARNING: no exact URL for ${sourceName} on property ${propertyId}. Marking as unverified.`);
    confidence = 'unverified';
  }

  const entry = {
    name: sourceName,
    url: exactUrl || null,
    confidence,
    date: new Date().toISOString(),
  };

  const updates = {};
  for (const field of fields) {
    updates[field] = entry;
  }

  await pool.query(
    `UPDATE properties SET data_sources = COALESCE(data_sources, '{}'::jsonb) || $1::jsonb WHERE id = $2`,
    [JSON.stringify(updates), propertyId]
  );
}

/**
 * Get all sources for a property.
 */
async function getAllSources(propertyId) {
  const { rows } = await pool.query(
    `SELECT data_sources FROM properties WHERE id = $1`,
    [propertyId]
  );
  return rows[0]?.data_sources || {};
}

/**
 * List all fields on a property that have data but no recorded source.
 */
async function getUnverifiedFields(propertyId) {
  const { rows } = await pool.query('SELECT * FROM properties WHERE id = $1', [propertyId]);
  if (!rows.length) return [];

  const prop = rows[0];
  const sources = prop.data_sources || {};

  const tracked = [
    'address_raw', 'address_normalised', 'suburb', 'city', 'province',
    'lat', 'lng', 'bedrooms', 'bathrooms', 'floor_area_sqm',
    'stand_size_sqm', 'property_type', 'construction_era',
    'roof_material', 'roof_orientation', 'solar_installed', 'security_visible',
    'erf_number', 'suburb_crime_score',
  ];

  const unverified = [];
  for (const field of tracked) {
    if (prop[field] != null && !sources[field]) {
      unverified.push(field);
    }
  }
  return unverified;
}

module.exports = { recordSource, getAllSources, getUnverifiedFields };
