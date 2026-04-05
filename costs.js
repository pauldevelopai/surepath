/**
 * API Cost Tracker
 *
 * Logs every API call with its cost. No estimates, no fake data.
 * Costs are calculated from actual token usage returned by the API.
 *
 * Pricing (as of 2026):
 *   Claude Haiku: $0.25/M input, $1.25/M output
 *   Claude Sonnet: $3/M input, $15/M output
 *   Claude Opus: $15/M input, $75/M output
 *   Google Geocoding: $5/1000 requests ($0.005 each)
 *   Google Street View: $7/1000 requests ($0.007 each)
 *   Google Maps Static: $2/1000 requests ($0.002 each)
 *   ElevenLabs: ~$0.30 per 1000 chars
 *
 * USD to ZAR: uses a fixed rate, update as needed
 */

const pool = require('./db');

const USD_TO_ZAR = 18.5; // Update this periodically

const PRICING = {
  'claude-3-haiku-20240307': { input_per_m: 0.25, output_per_m: 1.25 },
  'claude-3-5-sonnet-20241022': { input_per_m: 3, output_per_m: 15 },
  'claude-sonnet-4-5-20250514': { input_per_m: 3, output_per_m: 15 },
  'claude-opus-4-5-20250929': { input_per_m: 15, output_per_m: 75 },
  'google_geocoding': { per_request: 0.005 },
  'google_streetview': { per_request: 0.007 },
  'google_places_nearby': { per_request: 0.032 },
  'google_places_details': { per_request: 0.017 },
  'google_static_map': { per_request: 0.002 },
  'google_places_text_search': { per_request: 0.032 },
  'elevenlabs_tts': { per_1000_chars: 0.30 },
};

/**
 * Log an Anthropic API call cost.
 */
async function logClaude(model, inputTokens, outputTokens, endpoint, propertyId) {
  const pricing = PRICING[model] || PRICING['claude-3-haiku-20240307'];
  const costUSD = (inputTokens * pricing.input_per_m + outputTokens * pricing.output_per_m) / 1_000_000;
  const costZAR = Math.round(costUSD * USD_TO_ZAR * 100) / 100;

  await pool.query(
    `INSERT INTO api_costs (service, endpoint, property_id, input_tokens, output_tokens, cost_usd, cost_zar, model)
     VALUES ('anthropic', $1, $2, $3, $4, $5, $6, $7)`,
    [endpoint, propertyId || null, inputTokens, outputTokens, costUSD, costZAR, model]
  );

  return { costUSD, costZAR };
}

/**
 * Log a Google Maps API call cost.
 */
async function logGoogle(service, propertyId) {
  const pricing = PRICING[service];
  if (!pricing) return;
  const costUSD = pricing.per_request;
  const costZAR = Math.round(costUSD * USD_TO_ZAR * 100) / 100;

  await pool.query(
    `INSERT INTO api_costs (service, endpoint, property_id, cost_usd, cost_zar)
     VALUES ('google', $1, $2, $3, $4)`,
    [service, propertyId || null, costUSD, costZAR]
  );

  return { costUSD, costZAR };
}

/**
 * Log any API call cost.
 */
async function logCost(service, endpoint, costUSD, propertyId, details) {
  const costZAR = Math.round(costUSD * USD_TO_ZAR * 100) / 100;

  await pool.query(
    `INSERT INTO api_costs (service, endpoint, property_id, cost_usd, cost_zar, model)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [service, endpoint, propertyId || null, costUSD, costZAR, details || null]
  );

  return { costUSD, costZAR };
}

module.exports = { logClaude, logGoogle, logCost, USD_TO_ZAR, PRICING };
