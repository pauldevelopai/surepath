#!/usr/bin/env node
/**
 * SAPS POLICE STATION SCRAPER
 *
 * Scrapes all ~1,154 SAPS police stations from the SAPS website.
 * Each station page has: name, address, phone, email, GPS coordinates,
 * commander details, and cluster info.
 *
 * This is the foundation layer — every station has a CPF, so this gives
 * us CPF coverage for every precinct in South Africa.
 *
 * Usage:
 *   node bootstrap/scrape-saps-stations.js                    # Scrape all stations
 *   node bootstrap/scrape-saps-stations.js --start 1          # Start from station ID 1
 *   node bootstrap/scrape-saps-stations.js --end 100          # Stop at station ID 100
 *   node bootstrap/scrape-saps-stations.js --delay 2          # Seconds between requests
 *   node bootstrap/scrape-saps-stations.js --status           # Show DB stats only
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const https = require('https');
const pool = require('../db');

const MAX_STATION_ID = 1300; // IDs go up to ~1200, buffer for gaps
const DEFAULT_DELAY_SEC = 2;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Fetch a page via HTTPS ──────────────────────────────────────────

function fetchPage(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    };
    https.get(url, options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, url).href;
        return fetchPage(redirectUrl).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve(body));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ─── Parse a SAPS station detail page ────────────────────────────────

function parseStationPage(html, sapsId) {
  // Station name — usually in an h2 or h3 tag
  const nameMatch = html.match(/<h[23][^>]*>([^<]*(?:Police Station|SAPS)[^<]*)<\/h[23]>/i)
    || html.match(/<h[23][^>]*>([^<]+)<\/h[23]>/i)
    || html.match(/<title>([^<]*?)(?:\s*[-|]|<)/i);
  let stationName = nameMatch ? nameMatch[1].trim() : null;

  // Clean up station name
  if (stationName) {
    stationName = stationName
      .replace(/\s*SAPS\s*/gi, '')
      .replace(/\s*Police Station\s*/gi, '')
      .replace(/\s*-\s*South African Police Service\s*/i, '')
      .trim();
  }

  // Address
  const addressMatch = html.match(/(?:Physical\s*Address|Address)\s*[:：]\s*([^<]+)/i)
    || html.match(/<td[^>]*>\s*(?:Physical\s*)?Address\s*<\/td>\s*<td[^>]*>\s*([^<]+)/i);
  const address = addressMatch ? addressMatch[1].trim().replace(/&amp;/g, '&') : null;

  // Phone
  const phoneMatch = html.match(/(?:Tel(?:ephone)?|Phone)\s*[:：]\s*([0-9()+\s-]+)/i)
    || html.match(/<td[^>]*>\s*Tel(?:ephone)?\s*<\/td>\s*<td[^>]*>\s*([^<]+)/i);
  const phone = phoneMatch ? phoneMatch[1].trim() : null;

  // Email
  const emailMatch = html.match(/(?:Email|E-mail)\s*[:：]\s*([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i)
    || html.match(/href="mailto:([^"]+)"/i);
  const email = emailMatch ? emailMatch[1].trim().toLowerCase() : null;

  // GPS coordinates — SAPS pages often show these
  const latMatch = html.match(/(?:Latitude|Lat)\s*[:：]\s*(-?\d+\.?\d*)/i);
  const lngMatch = html.match(/(?:Longitude|Lng|Long)\s*[:：]\s*(-?\d+\.?\d*)/i);
  const lat = latMatch ? parseFloat(latMatch[1]) : null;
  const lng = lngMatch ? parseFloat(lngMatch[1]) : null;

  // Province
  const provinceMatch = html.match(/(?:Province)\s*[:：]\s*([^<,]+)/i)
    || html.match(/<td[^>]*>\s*Province\s*<\/td>\s*<td[^>]*>\s*([^<]+)/i);
  const province = provinceMatch ? provinceMatch[1].trim() : null;

  // Cluster
  const clusterMatch = html.match(/(?:Cluster)\s*[:：]\s*([^<,]+)/i)
    || html.match(/<td[^>]*>\s*Cluster\s*<\/td>\s*<td[^>]*>\s*([^<]+)/i);
  const cluster = clusterMatch ? clusterMatch[1].trim() : null;

  // Station commander
  const commanderMatch = html.match(/(?:Station\s*Commander|Commanding\s*Officer)\s*[:：]\s*([^<]+)/i)
    || html.match(/<td[^>]*>\s*Station Commander\s*<\/td>\s*<td[^>]*>\s*([^<]+)/i);
  const commanderName = commanderMatch ? commanderMatch[1].trim() : null;

  // Commander phone
  const cmdPhoneMatch = html.match(/(?:Commander.*?(?:Tel|Phone))\s*[:：]\s*([0-9()+\s-]+)/i);
  const commanderPhone = cmdPhoneMatch ? cmdPhoneMatch[1].trim() : null;

  return {
    saps_id: sapsId,
    station_name: stationName,
    address,
    phone,
    email,
    lat,
    lng,
    province,
    cluster,
    commander_name: commanderName,
    commander_phone: commanderPhone,
  };
}

// ─── Store a station in the database ─────────────────────────────────

async function storeStation(station) {
  if (!station.station_name) return false;

  const { rows } = await pool.query(
    `INSERT INTO saps_precincts (station_name, saps_id, address, phone, email, lat, lng, province, cluster, commander_name, commander_phone, scraped_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
     ON CONFLICT (saps_id) DO UPDATE SET
       station_name = EXCLUDED.station_name,
       address = COALESCE(EXCLUDED.address, saps_precincts.address),
       phone = COALESCE(EXCLUDED.phone, saps_precincts.phone),
       email = COALESCE(EXCLUDED.email, saps_precincts.email),
       lat = COALESCE(EXCLUDED.lat, saps_precincts.lat),
       lng = COALESCE(EXCLUDED.lng, saps_precincts.lng),
       province = COALESCE(EXCLUDED.province, saps_precincts.province),
       cluster = COALESCE(EXCLUDED.cluster, saps_precincts.cluster),
       commander_name = COALESCE(EXCLUDED.commander_name, saps_precincts.commander_name),
       commander_phone = COALESCE(EXCLUDED.commander_phone, saps_precincts.commander_phone),
       scraped_at = NOW()
     RETURNING id`,
    [station.station_name, station.saps_id, station.address, station.phone,
     station.email, station.lat, station.lng, station.province, station.cluster,
     station.commander_name, station.commander_phone]
  );
  return rows.length > 0;
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const startId = parseInt(args.find((_, i, a) => a[i - 1] === '--start') || '1');
  const endId = parseInt(args.find((_, i, a) => a[i - 1] === '--end') || String(MAX_STATION_ID));
  const delay = parseInt(args.find((_, i, a) => a[i - 1] === '--delay') || String(DEFAULT_DELAY_SEC));
  const statusOnly = args.includes('--status');

  if (statusOnly) {
    const { rows } = await pool.query('SELECT COUNT(*) AS c, COUNT(lat) AS geocoded FROM saps_precincts');
    const byProvince = await pool.query('SELECT province, COUNT(*) AS c FROM saps_precincts GROUP BY province ORDER BY c DESC');
    console.log(`[saps] ${rows[0].c} stations in DB (${rows[0].geocoded} geocoded)`);
    for (const r of byProvince.rows) {
      console.log(`  ${r.province || 'unknown'}: ${r.c}`);
    }
    process.exit(0);
  }

  console.log(`[saps] Scraping SAPS stations ${startId}–${endId} (delay: ${delay}s)`);

  let scraped = 0;
  let skipped = 0;
  let errors = 0;

  for (let sid = startId; sid <= endId; sid++) {
    const url = `https://www.saps.gov.za/contacts/stationdetails.php?sid=${sid}`;

    try {
      const html = await fetchPage(url);

      // Skip empty/error pages
      if (html.length < 500 || html.includes('No station found') || html.includes('Page not found')) {
        skipped++;
        continue;
      }

      const station = parseStationPage(html, sid);

      if (!station.station_name) {
        skipped++;
        continue;
      }

      const stored = await storeStation(station);
      if (stored) {
        scraped++;
        const coords = station.lat && station.lng ? `(${station.lat}, ${station.lng})` : 'no coords';
        console.log(`[saps] ${sid}: ${station.station_name} — ${station.province || '?'} — ${coords}`);
      }
    } catch (err) {
      if (err.message.includes('HTTP 404') || err.message.includes('HTTP 500')) {
        skipped++;
      } else {
        errors++;
        console.error(`[saps] ${sid}: Error — ${err.message}`);
      }
    }

    if (sid % 50 === 0) {
      console.log(`[saps] Progress: ${sid}/${endId} (${scraped} scraped, ${skipped} skipped, ${errors} errors)`);
    }

    await sleep(delay * 1000);
  }

  console.log(`\n[saps] Done: ${scraped} stations scraped, ${skipped} skipped, ${errors} errors`);

  // Summary
  const { rows } = await pool.query('SELECT COUNT(*) AS c FROM saps_precincts');
  console.log(`[saps] Total stations in DB: ${rows[0].c}`);

  process.exit(0);
}

main().catch(err => { console.error('[saps] Fatal:', err); process.exit(1); });
