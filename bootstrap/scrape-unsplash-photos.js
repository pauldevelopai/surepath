/**
 * Unsplash free photo scraper.
 * Uses Unsplash's public search pages — no API key required.
 * Downloads photos to our S3 bucket for long-term use.
 *
 * Unsplash photos are free to use under the Unsplash License.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pool = require('../db');
const { saveFile } = require('../storage');

const MAX_PER_KEYWORD = 3;

const KEYWORDS = [
  { category: 'exterior', keywords: ['suburban-house', 'modern-home', 'apartment-building'] },
  { category: 'interior', keywords: ['kitchen-interior', 'modern-bathroom', 'bedroom', 'living-room'] },
  { category: 'defect', keywords: ['water-damage', 'cracked-wall', 'mold', 'leak'] },
  { category: 'system', keywords: ['electrical-panel', 'solar-panel'] },
  { category: 'finance', keywords: ['signing-contract', 'house-keys', 'money-cash', 'calculator'] },
  { category: 'safety', keywords: ['security-camera', 'burglar-bars', 'fence'] },
  { category: 'emotion', keywords: ['stressed-person', 'worried-face', 'shocked', 'happy-family'] },
  { category: 'abstract', keywords: ['red-flag', 'warning-sign', 'documents'] },
];

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const options = { headers: { 'User-Agent': 'Mozilla/5.0 (SurepathBot/1.0)' } };
    https.get(url, options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => resolve(data));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(dest);
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        ws.close();
        return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        ws.close();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      res.pipe(ws);
      ws.on('finish', () => resolve(dest));
      ws.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Parse Unsplash search page and extract photo URLs + IDs.
 * Unsplash renders its search results with image URLs in the HTML
 * at https://images.unsplash.com/photo-XXXXX
 */
function parseUnsplashPage(html) {
  const photos = [];
  const seenIds = new Set();

  // Match photo URLs like: https://images.unsplash.com/photo-ABC123
  const regex = /https:\/\/images\.unsplash\.com\/photo-([a-zA-Z0-9_-]+)[^"'\s?]*/g;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const photoId = match[1];
    if (seenIds.has(photoId)) continue;
    seenIds.add(photoId);

    // Build clean URL with reasonable size — 1080 wide, for vertical format we crop later
    const cleanUrl = `https://images.unsplash.com/photo-${photoId}?w=1080&h=1920&fit=crop&auto=format`;
    photos.push({ id: photoId, url: cleanUrl });
  }

  return photos;
}

function savePhotoLocal(filePath, photoId) {
  const { url } = saveFile(filePath, 'stock/unsplash', `${photoId}.jpg`);
  return url;
}

async function processPhoto(photoUrl, photoId, category, keyword) {
  const { rows: existing } = await pool.query(
    'SELECT id FROM stock_footage WHERE source = $1 AND source_id = $2',
    ['unsplash', photoId]
  );
  if (existing.length > 0) return false;

  const tmpPath = path.join(os.tmpdir(), `unsplash_${photoId}.jpg`);

  try {
    await downloadFile(photoUrl, tmpPath);

    const s3Key = `content/stock/unsplash/${photoId}.jpg`;
    const s3Url = savePhotoLocal(tmpPath, photoId);

    await pool.query(
      `INSERT INTO stock_footage
        (source, source_id, media_type, video_url, s3_key, trimmed,
         duration_seconds, width, height, category, keyword, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (source, source_id) DO NOTHING`,
      ['unsplash', photoId, 'photo', s3Url, s3Key, false, null, 1080, 1920, category, keyword, `Unsplash: ${keyword}`]
    );
    return true;
  } finally {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
  }
}

async function scrapeKeyword(category, keyword) {
  const url = `https://unsplash.com/s/photos/${keyword}`;
  console.log(`[unsplash] ${category} / ${keyword}`);

  let html;
  try { html = await httpGet(url); }
  catch (e) { console.warn(`  [skip] ${e.message}`); return 0; }

  const photos = parseUnsplashPage(html).slice(0, MAX_PER_KEYWORD);
  console.log(`  Found ${photos.length} photos`);

  let added = 0;
  for (const photo of photos) {
    try {
      const stored = await processPhoto(photo.url, photo.id, category, keyword);
      if (stored) {
        added++;
        console.log(`  [ok] ${photo.id}`);
      }
    } catch (e) {
      console.error(`  [error] ${photo.id}: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return added;
}

async function run() {
  console.log('[unsplash] Starting scrape');
  let totalAdded = 0;

  for (const { category, keywords } of KEYWORDS) {
    for (const keyword of keywords) {
      try {
        const added = await scrapeKeyword(category, keyword);
        totalAdded += added;
      } catch (e) {
        console.error(`  [error] ${keyword}: ${e.message}`);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  const { rows } = await pool.query(
    "SELECT COUNT(*) as n FROM stock_footage WHERE source = 'unsplash'"
  );
  console.log(`[unsplash] DONE. Added ${totalAdded} new photos. DB total (unsplash): ${rows[0].n}`);
  process.exit(0);
}

run().catch((e) => {
  console.error('[unsplash] FATAL:', e);
  process.exit(1);
});
