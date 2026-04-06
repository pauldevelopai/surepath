/**
 * Load Shedding Schedule Collector
 * Uses the EskomSePush API (free tier: 50 calls/day) to get load shedding
 * schedules and area status.
 */
const pool = require('./db');

const ESP_BASE = 'https://developer.sepush.co.za/business/2.0';

async function fetchESP(endpoint, token) {
  const https = require('https');
  return new Promise((resolve) => {
    const url = `${ESP_BASE}${endpoint}`;
    const req = https.get(url, {
      headers: { 'Token': token, 'Accept': 'application/json' },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data: null }); }
      });
    });
    req.on('error', () => resolve({ status: 0, data: null }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, data: null }); });
  });
}

/**
 * Get load shedding info for a property's area.
 * Requires ESKOMSEPUSH_TOKEN env var (free at https://eskomsepush.gumroad.com/l/api)
 */
async function collectForProperty(propertyId) {
  const token = process.env.ESKOMSEPUSH_TOKEN;
  if (!token) return { error: 'ESKOMSEPUSH_TOKEN not set — get free key at eskomsepush.gumroad.com/l/api' };

  const { rows } = await pool.query('SELECT lat, lng, suburb, city FROM properties WHERE id = $1', [propertyId]);
  if (!rows[0]?.lat) return { error: 'not geocoded' };

  const { lat, lng, suburb, city } = rows[0];

  // Step 1: Find the area ID by searching suburb name
  const searchResult = await fetchESP(`/areas_search?text=${encodeURIComponent(suburb + ' ' + city)}`, token);
  if (!searchResult.data?.areas?.length) {
    console.log(`[loadshedding] No area found for ${suburb}, ${city}`);
    return { error: 'area not found' };
  }

  const area = searchResult.data.areas[0];
  console.log(`[loadshedding] Found area: ${area.name} (${area.id})`);

  // Step 2: Get the schedule for this area
  const scheduleResult = await fetchESP(`/area?id=${area.id}`, token);
  if (!scheduleResult.data) {
    return { error: 'schedule not available' };
  }

  const schedule = scheduleResult.data;
  const events = schedule.events || [];
  const nextEvent = events[0] || null;

  // Step 3: Get current national status
  const statusResult = await fetchESP('/status', token);
  const currentStage = statusResult.data?.status?.eskom?.stage || 0;

  const result = {
    area_name: area.name,
    area_id: area.id,
    current_stage: currentStage,
    next_loadshedding: nextEvent ? {
      start: nextEvent.start,
      end: nextEvent.end,
      stage: nextEvent.note,
    } : null,
    upcoming_events: events.slice(0, 5),
    region: area.region,
  };

  // Store
  try {
    await pool.query(
      `INSERT INTO area_risk_data (suburb, city, risk_type, risk_level, risk_score, details, source_name, data_date)
       VALUES ($1, $2, 'loadshedding', $3, $4, $5, 'eskomsepush', CURRENT_DATE)
       ON CONFLICT DO NOTHING`,
      [suburb, city,
       currentStage >= 4 ? 'HIGH' : currentStage >= 2 ? 'MEDIUM' : 'LOW',
       currentStage,
       JSON.stringify(result)]
    );
  } catch {}

  console.log(`[loadshedding] ${suburb}: stage ${currentStage}, next event: ${nextEvent?.start || 'none scheduled'}`);
  return result;
}

module.exports = { collectForProperty };
