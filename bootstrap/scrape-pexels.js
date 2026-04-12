/**
 * Pexels stock footage scraper.
 * Fetches vertical/square videos by property-related keywords and stores metadata.
 * No video files downloaded — we store URLs and let FFmpeg stream them during compose.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const https = require('https');
const pool = require('../db');

const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
if (!PEXELS_API_KEY) {
  console.error('FATAL: PEXELS_API_KEY not set');
  process.exit(1);
}

// Curated keywords organised by category — the visual matcher queries by category
const KEYWORDS = [
  // Exteriors
  { category: 'exterior', keywords: ['suburban house', 'modern home exterior', 'apartment building', 'south african house', 'townhouse', 'housing estate'] },
  // Interior rooms
  { category: 'interior', keywords: ['empty kitchen', 'modern bathroom', 'bedroom interior', 'living room home', 'empty house walkthrough'] },
  // Defects & problems
  { category: 'defect', keywords: ['water damage ceiling', 'cracked wall', 'mould wall', 'rusty pipes', 'leaking roof', 'damaged floor'] },
  // Systems
  { category: 'system', keywords: ['electrical panel', 'solar panel roof', 'geyser water heater', 'air conditioning unit'] },
  // Finance & signing
  { category: 'finance', keywords: ['signing contract', 'house keys handshake', 'money cash south africa', 'mortgage document', 'calculator house', 'rand money'] },
  // Crime & safety
  { category: 'safety', keywords: ['security camera home', 'burglar bars window', 'electric fence gate', 'neighbourhood night street'] },
  // Emotion
  { category: 'emotion', keywords: ['stressed couple home', 'shocked face reaction', 'worried buyer', 'happy family house', 'regret decision'] },
  // Abstract / b-roll
  { category: 'abstract', keywords: ['falling money', 'blueprint plans', 'red warning tape', 'stop sign', 'magnifying glass document', 'red flag warning'] },
];

const PER_KEYWORD = 5;      // videos per keyword
const TARGET_ORIENTATION = 'portrait'; // reels are vertical

function pexelsRequest(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.pexels.com',
      path,
      method: 'GET',
      headers: {
        'Authorization': PEXELS_API_KEY,
        'User-Agent': 'Surepath/1.0',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`Pexels ${res.statusCode}: ${data.substring(0, 300)}`));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Pexels invalid JSON`)); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

async function fetchVideos(keyword) {
  const encoded = encodeURIComponent(keyword);
  const path = `/videos/search?query=${encoded}&per_page=${PER_KEYWORD}&orientation=${TARGET_ORIENTATION}&size=medium`;
  const res = await pexelsRequest(path);
  return res.videos || [];
}

function pickBestFile(videoFiles) {
  // Prefer HD portrait files, fall back to best available
  const portrait = videoFiles.filter((f) => f.height > f.width);
  const sorted = (portrait.length > 0 ? portrait : videoFiles).sort((a, b) => {
    // Favour resolutions around 1080x1920
    const scoreA = Math.abs(1920 - (a.height || 0)) + Math.abs(1080 - (a.width || 0));
    const scoreB = Math.abs(1920 - (b.height || 0)) + Math.abs(1080 - (b.width || 0));
    return scoreA - scoreB;
  });
  return sorted[0];
}

async function storeVideo(video, category, keyword) {
  const file = pickBestFile(video.video_files || []);
  if (!file) {
    console.log(`  [skip] No usable file for video ${video.id}`);
    return false;
  }

  const thumb = (video.video_pictures || [])[0]?.picture || null;

  try {
    await pool.query(
      `INSERT INTO stock_footage
        (source, source_id, video_url, thumbnail_url, preview_url,
         duration_seconds, width, height, category, keyword,
         tags, description, photographer)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (source, source_id) DO NOTHING`,
      [
        'pexels',
        String(video.id),
        file.link,
        thumb,
        video.image,
        video.duration,
        file.width,
        file.height,
        category,
        keyword,
        JSON.stringify(video.tags || []),
        video.url,
        video.user?.name || null,
      ]
    );
    return true;
  } catch (e) {
    console.error(`  [error] Failed to insert ${video.id}: ${e.message}`);
    return false;
  }
}

async function run() {
  console.log('[pexels] Starting scrape — keywords:',
    KEYWORDS.reduce((n, c) => n + c.keywords.length, 0));

  let total = 0;
  let added = 0;

  for (const { category, keywords } of KEYWORDS) {
    for (const keyword of keywords) {
      console.log(`[pexels] ${category} / "${keyword}"`);
      try {
        const videos = await fetchVideos(keyword);
        console.log(`  Found ${videos.length} videos`);
        for (const v of videos) {
          total++;
          const stored = await storeVideo(v, category, keyword);
          if (stored) added++;
        }
        // Be polite — Pexels allows 200 requests/hour
        await new Promise((r) => setTimeout(r, 500));
      } catch (e) {
        console.error(`  [error] "${keyword}": ${e.message}`);
      }
    }
  }

  // Final count in DB
  const { rows } = await pool.query('SELECT COUNT(*) as n, COUNT(DISTINCT category) as cats FROM stock_footage');
  console.log(`[pexels] DONE. Processed ${total}, added ${added} new. DB total: ${rows[0].n} across ${rows[0].cats} categories.`);
  process.exit(0);
}

run().catch((e) => {
  console.error('[pexels] FATAL:', e);
  process.exit(1);
});
