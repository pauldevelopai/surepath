/**
 * Extract structured data from property listing descriptions using Claude.
 *
 * Takes a free-text description and returns structured fields.
 * Every extracted field is recorded with provenance:
 *   source: "Claude extraction from listing description"
 *   confidence: "estimated"
 *   url: the original listing URL
 */

const Anthropic = require('@anthropic-ai/sdk');
const pool = require('./db');
const { recordSource } = require('./provenance');

const client = new Anthropic();

/**
 * Extract structured data from a property description.
 *
 * @param {string} description - The listing description text
 * @returns {object} Structured data fields
 */
async function extractFromDescription(description) {
  if (!description || description.length < 20) return null;

  const message = await client.messages.create({
    model: require('./model-config').getModel('extract'),
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: `Extract structured data from this South African property listing description. Return ONLY valid JSON with these fields (use null for anything not mentioned, never guess):

{
  "building_name": "name of building/complex if mentioned, e.g. 'The Aster', 'The Edge'",
  "unit_number": "unit/apartment number if mentioned, e.g. '401', '12B'",
  "street_address_extracted": "full street address if mentioned",
  "views": "what views are mentioned, e.g. 'Table Mountain', 'sea views', 'city views'",
  "flooring": "flooring type if mentioned, e.g. 'wooden', 'Oggie flooring', 'tiles'",
  "has_pool": false,
  "has_garden": false,
  "has_braai": false,
  "has_jacuzzi": false,
  "has_balcony": false,
  "has_aircon": false,
  "has_alarm": false,
  "has_electric_fence": false,
  "has_cctv": false,
  "has_borehole": false,
  "has_solar_geyser": false,
  "has_generator": false,
  "has_fibre": false,
  "storage_sqm": null,
  "airbnb_friendly": false,
  "security_details": "describe security features mentioned",
  "near_amenities": ["list", "of", "nearby", "amenities"],
  "selling_points": ["key", "selling", "points", "from", "description"]
}

Only set booleans to true if explicitly mentioned. For selling_points, extract 3-5 key facts.

Description:
${description}`,
    }],
  });

  // Log cost
  try {
    const { logClaude } = require('./costs');
    await logClaude(require('./model-config').getModel('extract'), message.usage.input_tokens, message.usage.output_tokens, 'extract/features');
  } catch {}

  let text = message.content[0].text.trim();
  if (text.startsWith('```')) text = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');

  try {
    return JSON.parse(text);
  } catch {
    console.error('[extract] Failed to parse Claude response:', text.substring(0, 200));
    return null;
  }
}

/**
 * Process a property: extract features from description and store.
 *
 * @param {number} propertyId
 * @returns {{ fields_updated: number }}
 */
async function processProperty(propertyId) {
  const { rows } = await pool.query(
    'SELECT id, description, listing_url, street_address FROM properties WHERE id = $1',
    [propertyId]
  );

  if (!rows.length) throw new Error(`Property ${propertyId} not found`);
  const prop = rows[0];

  if (!prop.description) return { fields_updated: 0, message: 'No description to process' };

  const extracted = await extractFromDescription(prop.description);
  if (!extracted) return { fields_updated: 0, message: 'Extraction failed' };

  // Build update query — only set fields that were extracted (not null)
  const updates = [];
  const values = [];
  let idx = 1;
  const trackedFields = [];

  function addField(dbCol, value) {
    if (value == null || value === false) return;
    // For booleans, only add if true
    if (typeof value === 'boolean' && !value) return;
    updates.push(`${dbCol} = $${idx++}`);
    values.push(typeof value === 'object' ? JSON.stringify(value) : value);
    trackedFields.push(dbCol);
  }

  addField('building_name', extracted.building_name);
  addField('unit_number', extracted.unit_number);
  addField('views', extracted.views);
  addField('flooring', extracted.flooring);
  addField('has_pool', extracted.has_pool);
  addField('has_garden', extracted.has_garden);
  addField('has_braai', extracted.has_braai);
  addField('has_jacuzzi', extracted.has_jacuzzi);
  addField('has_balcony', extracted.has_balcony);
  addField('has_aircon', extracted.has_aircon);
  addField('has_alarm', extracted.has_alarm);
  addField('has_electric_fence', extracted.has_electric_fence);
  addField('has_cctv', extracted.has_cctv);
  addField('has_borehole', extracted.has_borehole);
  addField('has_solar_geyser', extracted.has_solar_geyser);
  addField('has_generator', extracted.has_generator);
  addField('has_fibre', extracted.has_fibre);
  addField('airbnb_friendly', extracted.airbnb_friendly);
  addField('security_details', extracted.security_details);
  addField('extracted_features', extracted);

  if (extracted.storage_sqm) {
    addField('storage_sqm', parseInt(extracted.storage_sqm) || null);
  }

  // Update street address if we don't have one and extraction found one
  if (!prop.street_address && extracted.street_address_extracted) {
    addField('street_address', extracted.street_address_extracted);
  }

  // Arrays need special handling for PostgreSQL
  if (extracted.near_amenities?.length > 0) {
    updates.push(`near_amenities = $${idx++}`);
    values.push(extracted.near_amenities);
    trackedFields.push('near_amenities');
  }
  if (extracted.selling_points?.length > 0) {
    updates.push(`selling_points = $${idx++}`);
    values.push(extracted.selling_points);
    trackedFields.push('selling_points');
  }

  if (updates.length === 0) return { fields_updated: 0, message: 'No data extracted' };

  values.push(propertyId);
  await pool.query(
    `UPDATE properties SET ${updates.join(', ')} WHERE id = $${idx}`,
    values
  );

  // Record provenance — source is Claude extraction from the listing description
  const sourceUrl = prop.listing_url || null;
  await recordSource(
    propertyId,
    'Claude extraction from listing description',
    sourceUrl,
    'estimated',
    trackedFields
  );

  return { fields_updated: trackedFields.length, fields: trackedFields, extracted };
}

/**
 * Batch process all properties with descriptions that haven't been extracted yet.
 */
async function processAll(limit) {
  const { rows } = await pool.query(
    `SELECT id, address_raw FROM properties
     WHERE description IS NOT NULL AND extracted_features IS NULL
     ORDER BY id
     ${limit ? `LIMIT ${limit}` : ''}`
  );

  console.log(`Processing ${rows.length} properties with unextracted descriptions`);

  let processed = 0;
  let totalFields = 0;

  for (const prop of rows) {
    try {
      const result = await processProperty(prop.id);
      processed++;
      totalFields += result.fields_updated;
      console.log(`  #${prop.id}: ${result.fields_updated} fields — ${prop.address_raw}`);
    } catch (err) {
      console.error(`  #${prop.id}: ERROR — ${err.message}`);
    }
  }

  console.log(`\nProcessed: ${processed}, Total fields extracted: ${totalFields}`);
}

module.exports = { extractFromDescription, processProperty, processAll };

if (require.main === module) {
  // Must be run with: node -e "require('dotenv').config()" && node extract-features.js
  // Or: DATABASE_URL=... ANTHROPIC_API_KEY=... node extract-features.js
  const limit = process.argv.includes('--limit') ? parseInt(process.argv[process.argv.indexOf('--limit') + 1]) : null;
  processAll(limit).then(() => pool.end()).catch(err => { console.error(err); pool.end(); process.exit(1); });
}
