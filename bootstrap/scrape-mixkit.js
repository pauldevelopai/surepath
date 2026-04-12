/**
 * Mixkit free stock footage scraper.
 * Scrapes Mixkit's public search pages (no API key needed), downloads clips,
 * trims to 2 seconds with FFmpeg, and uploads to our S3 bucket.
 *
 * Mixkit videos are free for commercial use under their Content License.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const pool = require('../db');
const { saveFile } = require('../storage');

const MAX_CLIP_DURATION = 5; // only trim if source is longer than this
const MAX_PER_KEYWORD = 4;

// Same category → keyword mapping as Pexels, but using Mixkit search terms
const KEYWORDS = [
  { category: 'exterior', keywords: ['house', 'modern-home', 'neighborhood', 'suburb'] },
  { category: 'interior', keywords: ['kitchen', 'bathroom', 'bedroom', 'living-room'] },
  { category: 'defect', keywords: ['water-damage', 'crack-wall', 'mold', 'rust', 'leak'] },
  { category: 'system', keywords: ['solar-panel', 'air-conditioner', 'wiring'] },
  { category: 'finance', keywords: ['contract', 'keys', 'money', 'calculator', 'handshake'] },
  { category: 'safety', keywords: ['security-camera', 'fence', 'gate', 'alarm'] },
  { category: 'emotion', keywords: ['stressed', 'shocked', 'worried', 'happy'] },
  { category: 'abstract', keywords: ['red-flag', 'warning', 'magnifying-glass', 'documents'] },
];

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: { 'User-Agent': 'Mozilla/5.0 (SurepathBot/1.0)' },
    };
    https.get(url, options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`)));
        return;
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
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
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
    });
    req.on('error', reject);
  });
}

/**
 * Parse Mixkit search page HTML and extract video download URLs + metadata.
 */
function parseMixkitPage(html) {
  const videos = [];

  // Mixkit embeds video info in anchor tags linking to videos, with preview MP4s
  // Pattern: <a href="/free-stock-video/[slug]/"> ... <video src="https://...mp4">
  // Easier pattern: all video source URLs
  const videoUrls = new Set();
  const mp4Regex = /https:\/\/assets\.mixkit\.co\/[^"'\s]+\.mp4/g;
  let match;
  while ((match = mp4Regex.exec(html)) !== null) {
    videoUrls.add(match[0]);
  }

  // Slug extraction — each clip has a unique slug
  const slugRegex = /\/free-stock-video\/([a-z0-9-]+)\//g;
  const slugs = new Set();
  while ((match = slugRegex.exec(html)) !== null) {
    slugs.add(match[1]);
  }

  // Pair them up — in Mixkit HTML, video URLs appear near their slug
  // Simplest approach: treat each unique MP4 as a candidate clip
  for (const url of videoUrls) {
    // Try to extract an ID from the URL (filename before extension)
    const filename = url.split('/').pop().replace('.mp4', '');
    videos.push({ url, id: filename });
  }

  return videos;
}

/**
 * Rescale to 1080x1920 portrait, and only trim if source exceeds MAX_CLIP_DURATION.
 * Returns the actual duration of the output.
 */
function rescaleAndMaybeTrim(inputPath, outputPath) {
  // Probe source duration
  let sourceDuration;
  try {
    const probe = execSync(
      `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${inputPath}"`,
      { encoding: 'utf8' }
    ).trim();
    sourceDuration = parseFloat(probe) || MAX_CLIP_DURATION;
  } catch {
    sourceDuration = MAX_CLIP_DURATION;
  }

  const finalDuration = Math.min(sourceDuration, MAX_CLIP_DURATION);
  const trimFlag = sourceDuration > MAX_CLIP_DURATION ? `-t ${MAX_CLIP_DURATION}` : '';

  const cmd = `ffmpeg -y -i "${inputPath}" ${trimFlag} -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1" -c:v libx264 -preset fast -crf 23 -an -movflags +faststart "${outputPath}" 2>&1`;
  execSync(cmd, { stdio: 'pipe', timeout: 60000 });

  return finalDuration;
}

// Save trimmed clip to local content dir; return public URL.
function saveClipLocal(filePath, sourceId) {
  const { url } = saveFile(filePath, 'stock/mixkit', `${sourceId}.mp4`);
  return url;
}

async function processClip(videoUrl, sourceId, category, keyword) {
  // Skip if we already have this clip
  const { rows: existing } = await pool.query(
    'SELECT id FROM stock_footage WHERE source = $1 AND source_id = $2',
    ['mixkit', sourceId]
  );
  if (existing.length > 0) return false;

  const tmpDownload = path.join(os.tmpdir(), `mixkit_${Date.now()}_${sourceId}.mp4`);
  const tmpTrimmed = path.join(os.tmpdir(), `mixkit_trimmed_${Date.now()}_${sourceId}.mp4`);

  try {
    await downloadFile(videoUrl, tmpDownload);
    const actualDuration = rescaleAndMaybeTrim(tmpDownload, tmpTrimmed);

    // Save to Lightsail disk, served at https://surepath.co.za/content/stock/mixkit/...
    const publicUrl = saveClipLocal(tmpTrimmed, sourceId);
    const s3Key = `content/stock/mixkit/${sourceId}.mp4`;  // kept as filesystem-relative key for reference

    await pool.query(
      `INSERT INTO stock_footage
        (source, source_id, media_type, video_url, s3_key, trimmed, duration_seconds,
         width, height, category, keyword, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (source, source_id) DO NOTHING`,
      ['mixkit', sourceId, 'video', publicUrl, s3Key, actualDuration < 5, actualDuration, 1080, 1920, category, keyword, `Mixkit: ${keyword}`]
    );

    return true;
  } finally {
    try { if (fs.existsSync(tmpDownload)) fs.unlinkSync(tmpDownload); } catch {}
    try { if (fs.existsSync(tmpTrimmed)) fs.unlinkSync(tmpTrimmed); } catch {}
  }
}

async function scrapeKeyword(category, keyword) {
  const url = `https://mixkit.co/free-stock-video/${keyword}/`;
  console.log(`[mixkit] ${category} / ${keyword} → ${url}`);

  let html;
  try {
    html = await httpGet(url);
  } catch (e) {
    console.warn(`  [skip] ${e.message}`);
    return 0;
  }

  const clips = parseMixkitPage(html).slice(0, MAX_PER_KEYWORD);
  console.log(`  Found ${clips.length} clips`);

  let added = 0;
  for (const clip of clips) {
    try {
      const stored = await processClip(clip.url, clip.id, category, keyword);
      if (stored) {
        added++;
        console.log(`  [ok] ${clip.id}`);
      }
    } catch (e) {
      console.error(`  [error] ${clip.id}: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return added;
}

async function run() {
  try { execSync('ffmpeg -version', { stdio: 'pipe' }); }
  catch { throw new Error('FFmpeg required but not installed'); }

  console.log('[mixkit] Starting scrape');
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
    "SELECT COUNT(*) as n FROM stock_footage WHERE source = 'mixkit'"
  );
  console.log(`[mixkit] DONE. Added ${totalAdded} new clips. DB total (mixkit): ${rows[0].n}`);
  process.exit(0);
}

run().catch((e) => {
  console.error('[mixkit] FATAL:', e);
  process.exit(1);
});
