/**
 * USD/ZAR Exchange Rate — fetched weekly from a free API.
 *
 * Uses open.er-api.com (no key required).
 * Caches to /tmp/surepath-exchange-rate.json for 7 days.
 * Falls back to last known rate if fetch fails.
 */
const fs = require('fs');
const https = require('https');

const CACHE_FILE = '/tmp/surepath-exchange-rate.json';
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const FALLBACK_RATE = 18.3; // Last known rate if everything fails

function fetchJSON(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function readCache() {
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeCache(rate, source) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({
      rate,
      source,
      fetched_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + CACHE_MAX_AGE_MS).toISOString(),
    }));
  } catch {}
}

/**
 * Get current USD/ZAR exchange rate.
 * Returns from cache if fresh, otherwise fetches from API.
 */
async function getRate() {
  // Check cache first
  const cached = readCache();
  if (cached && cached.rate && new Date(cached.expires_at) > new Date()) {
    return { rate: cached.rate, source: cached.source, cached: true, fetched_at: cached.fetched_at };
  }

  // Try primary: open.er-api.com (free, no key)
  const primary = await fetchJSON('https://open.er-api.com/v6/latest/USD');
  if (primary?.rates?.ZAR) {
    const rate = Math.round(primary.rates.ZAR * 100) / 100;
    writeCache(rate, 'open.er-api.com');
    return { rate, source: 'open.er-api.com', cached: false, fetched_at: new Date().toISOString() };
  }

  // Try fallback: frankfurter.app (free, no key)
  const fallback = await fetchJSON('https://api.frankfurter.app/latest?from=USD&to=ZAR');
  if (fallback?.rates?.ZAR) {
    const rate = Math.round(fallback.rates.ZAR * 100) / 100;
    writeCache(rate, 'frankfurter.app');
    return { rate, source: 'frankfurter.app', cached: false, fetched_at: new Date().toISOString() };
  }

  // Use stale cache if available
  if (cached?.rate) {
    return { rate: cached.rate, source: `${cached.source} (stale)`, cached: true, fetched_at: cached.fetched_at };
  }

  // Last resort
  return { rate: FALLBACK_RATE, source: 'hardcoded fallback', cached: false, fetched_at: null };
}

/**
 * Synchronous version — returns cached rate or fallback.
 * Use this in hot paths where you can't await.
 */
function getRateSync() {
  const cached = readCache();
  if (cached?.rate) return cached.rate;
  return FALLBACK_RATE;
}

module.exports = { getRate, getRateSync, FALLBACK_RATE };
