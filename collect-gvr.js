#!/usr/bin/env node
/**
 * Municipal General Valuation Roll (GVR) Collector
 *
 * Seeds the properties table with data from publicly available GVRs.
 * Every SA municipality must publish their GVR under the Municipal Property
 * Rates Act. This data is FREE.
 *
 * Usage:
 *   node collect-gvr.js                          # All metros
 *   node collect-gvr.js --metro cape_town        # Single metro
 *   node collect-gvr.js --metro johannesburg
 *
 * Covers: Cape Town, Johannesburg, Tshwane, eThekwini, Ekurhuleni, NMB
 */

require('dotenv').config();
const https = require('https');
const http = require('http');
const pool = require('./db');
const cheerio = require('cheerio');

const DELAY_MS = 3000;
const USER_AGENT = 'SurePath/1.0 PropertyIntelligence';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function log(msg) {
  console.log(`[${new Date().toISOString().substring(0, 19)}] ${msg}`);
}

// ─── HTTP fetch ─────────────────────────────────────────────────────────

function fetchPage(url) {
  const mod = url.startsWith('https') ? https : http;
  const parsed = new (require('url').URL)(url);
  return new Promise((resolve, reject) => {
    mod.get({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: { 'User-Agent': USER_AGENT },
      timeout: 30000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location.startsWith('http') ? res.headers.location : `${parsed.protocol}//${parsed.hostname}${res.headers.location}`;
        return fetchPage(loc).then(resolve).catch(reject);
      }
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode} for ${url}`)); return; }
        resolve(body);
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ─── Metro configurations ───────────────────────────────────────────────

const METROS = {
  cape_town: {
    name: 'City of Cape Town',
    prefix: 'CPT',
    province: 'Western Cape',
    city: 'Cape Town',
    // Cape Town publishes GVR via their web portal
    searchUrl: 'https://web1.capetown.gov.za/web1/gv2022/Results',
    bulkUrl: 'https://www.capetown.gov.za/Family%20and%20home/residential-property-and-houses/property-valuations/current-and-upcoming-valuations',
    type: 'portal',
  },
  johannesburg: {
    name: 'City of Johannesburg',
    prefix: 'JHB',
    province: 'Gauteng',
    city: 'Johannesburg',
    bulkUrl: 'https://www.joburg.org.za/services_/Pages/Valuation-Roll.aspx',
    portalUrl: 'https://ebo.joburg.org.za/web/igbportal/home',
    type: 'portal',
  },
  tshwane: {
    name: 'City of Tshwane',
    prefix: 'TSH',
    province: 'Gauteng',
    city: 'Pretoria',
    bulkUrl: 'https://www.tshwane.gov.za/services/rates-and-taxes/general-valuation-roll',
    type: 'portal',
  },
  ethekwini: {
    name: 'eThekwini Municipality',
    prefix: 'ETH',
    province: 'KwaZulu-Natal',
    city: 'Durban',
    bulkUrl: 'https://www.durban.gov.za/city_government/city_governance/rates_taxes_valuations/Pages/GVR.aspx',
    type: 'portal',
  },
  ekurhuleni: {
    name: 'City of Ekurhuleni',
    prefix: 'EKU',
    province: 'Gauteng',
    city: 'Ekurhuleni',
    bulkUrl: 'https://www.ekurhuleni.gov.za/residents/rates-and-taxes',
    type: 'portal',
  },
  nelson_mandela_bay: {
    name: 'Nelson Mandela Bay',
    prefix: 'NMB',
    province: 'Eastern Cape',
    city: 'Port Elizabeth',
    bulkUrl: 'https://www.nelsonmandelabay.gov.za/services/valuationRoll',
    type: 'portal',
  },
};

// ─── GVR row normalisation ──────────────────────────────────────────────

function parseGVRRow(rawRow, metroConfig) {
  return {
    erf_number: `${metroConfig.prefix}_${rawRow.erf || rawRow.erf_number || rawRow.property_ref || 'UNKNOWN'}`,
    address_raw: rawRow.address || rawRow.physical_address || rawRow.street_address || null,
    suburb: rawRow.suburb || rawRow.township || rawRow.area || null,
    city: metroConfig.city,
    province: metroConfig.province,
    owner_name_gvr: rawRow.owner || rawRow.owner_name || rawRow.registered_owner || null,
    stand_size_sqm: parseInt(rawRow.extent || rawRow.size_sqm || '0') || null,
    municipal_value: parseInt(rawRow.market_value || rawRow.municipal_value || rawRow.value || '0') || null,
    zoning: rawRow.zoning || rawRow.land_use || null,
    property_category: rawRow.category || rawRow.property_type || rawRow.property_category || null,
    gvr_source: metroConfig.name,
    gvr_fetched_at: new Date(),
  };
}

// ─── Bulk upsert ────────────────────────────────────────────────────────

async function upsertFromGVR(properties) {
  let inserted = 0, updated = 0, skipped = 0;

  for (const p of properties) {
    if (!p.erf_number || p.erf_number.endsWith('_UNKNOWN')) { skipped++; continue; }

    try {
      const { rows } = await pool.query(
        `INSERT INTO properties (
          erf_number, address_raw, suburb, city, province,
          owner_name_gvr, stand_size_sqm, municipal_valuation, zoning,
          property_category, gvr_source, gvr_fetched_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (erf_number) DO UPDATE SET
          address_raw = COALESCE(NULLIF(properties.address_raw, ''), EXCLUDED.address_raw),
          suburb = COALESCE(properties.suburb, EXCLUDED.suburb),
          city = COALESCE(properties.city, EXCLUDED.city),
          province = COALESCE(properties.province, EXCLUDED.province),
          owner_name_gvr = CASE WHEN properties.last_deeds_lookup IS NULL
            THEN COALESCE(EXCLUDED.owner_name_gvr, properties.owner_name_gvr)
            ELSE properties.owner_name_gvr END,
          stand_size_sqm = COALESCE(properties.stand_size_sqm, EXCLUDED.stand_size_sqm),
          municipal_valuation = COALESCE(EXCLUDED.municipal_valuation, properties.municipal_valuation),
          zoning = COALESCE(EXCLUDED.zoning, properties.zoning),
          property_category = COALESCE(EXCLUDED.property_category, properties.property_category),
          gvr_source = EXCLUDED.gvr_source,
          gvr_fetched_at = EXCLUDED.gvr_fetched_at
        RETURNING (xmax = 0) AS is_insert`,
        [p.erf_number, p.address_raw, p.suburb, p.city, p.province,
         p.owner_name_gvr, p.stand_size_sqm, p.municipal_value, p.zoning,
         p.property_category, p.gvr_source, p.gvr_fetched_at]
      );

      if (rows[0]?.is_insert) inserted++;
      else updated++;
    } catch (err) {
      skipped++;
      if (!err.message.includes('duplicate')) {
        console.error(`[gvr] Upsert error for ${p.erf_number}: ${err.message}`);
      }
    }
  }

  return { inserted, updated, skipped };
}

// ─── Metro scraper: portal-based ────────────────────────────────────────

async function scrapeMetroGVR(metroName, config) {
  log(`Scraping GVR for ${config.name}...`);
  const properties = [];

  try {
    // Step 1: Check for bulk download links
    const html = await fetchPage(config.bulkUrl || config.searchUrl);
    const $ = cheerio.load(html);

    // Look for downloadable files (CSV, Excel, PDF)
    const downloadLinks = [];
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const text = $(el).text().toLowerCase();
      if (href.match(/\.(csv|xlsx?|xls)$/i) || text.includes('download') || text.includes('valuation roll')) {
        const fullUrl = href.startsWith('http') ? href : new URL(href, config.bulkUrl).href;
        downloadLinks.push({ url: fullUrl, text: $(el).text().trim() });
      }
    });

    if (downloadLinks.length > 0) {
      log(`  Found ${downloadLinks.length} download links for ${config.name}`);
      for (const link of downloadLinks) {
        log(`  → ${link.text}: ${link.url}`);
        if (link.url.endsWith('.csv')) {
          try {
            const csvData = await fetchPage(link.url);
            const rows = parseCSV(csvData);
            for (const row of rows) {
              properties.push(parseGVRRow(row, config));
            }
            log(`  Parsed ${rows.length} rows from CSV`);
          } catch (err) {
            log(`  CSV parse error: ${err.message}`);
          }
        } else if (link.url.match(/\.pdf$/i)) {
          log(`  SKIP: PDF file — cannot parse automatically`);
        } else {
          log(`  SKIP: ${link.url.split('.').pop()} format — manual download required`);
        }
        await sleep(DELAY_MS);
      }
    }

    // Step 2: Try to extract property data from the HTML page itself
    // Many metro portals show property data in HTML tables
    const tables = $('table');
    if (tables.length > 0 && properties.length === 0) {
      tables.each((_, table) => {
        const headers = [];
        $(table).find('th').each((_, th) => headers.push($(th).text().trim().toLowerCase()));

        if (headers.some(h => h.includes('erf') || h.includes('property') || h.includes('valuation'))) {
          $(table).find('tr').each((_, tr) => {
            const cells = [];
            $(tr).find('td').each((_, td) => cells.push($(td).text().trim()));
            if (cells.length >= 3) {
              const row = {};
              headers.forEach((h, i) => { if (cells[i]) row[h.replace(/\s+/g, '_')] = cells[i]; });
              properties.push(parseGVRRow(row, config));
            }
          });
        }
      });

      if (properties.length > 0) {
        log(`  Extracted ${properties.length} properties from HTML tables`);
      }
    }

    if (properties.length === 0) {
      log(`  No bulk data found for ${config.name} — may require manual CSV download`);
      log(`  Check: ${config.bulkUrl}`);
    }
  } catch (err) {
    log(`  ERROR scraping ${config.name}: ${err.message}`);
  }

  return properties;
}

// ─── CSV parser (no external deps) ──────────────────────────────────────

function parseCSV(csvText) {
  const lines = csvText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map(h => h.replace(/"/g, '').trim().toLowerCase().replace(/\s+/g, '_'));
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',').map(v => v.replace(/"/g, '').trim());
    const row = {};
    headers.forEach((h, j) => { row[h] = values[j] || null; });
    rows.push(row);
  }

  return rows;
}

// ─── Collection orchestrators ───────────────────────────────────────────

async function collectGVRByMetro(metroName) {
  const config = METROS[metroName];
  if (!config) {
    log(`Unknown metro: ${metroName}. Available: ${Object.keys(METROS).join(', ')}`);
    return { inserted: 0, updated: 0, skipped: 0 };
  }

  const properties = await scrapeMetroGVR(metroName, config);
  if (properties.length === 0) return { inserted: 0, updated: 0, skipped: 0 };

  log(`Upserting ${properties.length} properties for ${config.name}...`);
  const result = await upsertFromGVR(properties);
  log(`  ${config.name}: ${result.inserted} inserted, ${result.updated} updated, ${result.skipped} skipped`);
  return result;
}

async function collectAllGVRs() {
  log('=== GVR Collection Started ===');
  const totals = { inserted: 0, updated: 0, skipped: 0 };

  const metroNames = (process.env.GVR_METROS || Object.keys(METROS).join(',')).split(',').map(s => s.trim());

  for (const metroName of metroNames) {
    try {
      const result = await collectGVRByMetro(metroName);
      totals.inserted += result.inserted;
      totals.updated += result.updated;
      totals.skipped += result.skipped;
    } catch (err) {
      log(`ERROR in ${metroName}: ${err.message}`);
    }
    await sleep(DELAY_MS);
  }

  log(`=== GVR Collection Complete: ${totals.inserted} inserted, ${totals.updated} updated, ${totals.skipped} skipped ===`);
  return totals;
}

// ─── CLI ────────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const metroIdx = args.indexOf('--metro');

  (async () => {
    if (metroIdx >= 0 && args[metroIdx + 1]) {
      await collectGVRByMetro(args[metroIdx + 1]);
    } else {
      await collectAllGVRs();
    }
    await pool.end();
  })();
}

module.exports = { collectGVRByMetro, collectAllGVRs, scrapeMetroGVR, parseGVRRow, upsertFromGVR, METROS };
