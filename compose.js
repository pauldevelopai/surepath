const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');
const pool = require('./db');
const { saveFile } = require('./storage');

const LOGO_PATH = process.env.SUREPATH_LOGO_PATH || path.resolve(__dirname, 'dashboard', 'public', 'surepath-logo.png');

// Brand colours
const BRAND_RED = '#E63946';
const BRAND_DARK = '#0D1B2A';
const WHATSAPP_GREEN = '#25D366';

// WhatsApp contact — appears at the end of every video
const WHATSAPP_NUMBER = process.env.SUREPATH_WHATSAPP_NUMBER || '+27 79 219 8649';
const WHATSAPP_BANNER_DURATION = 3; // seconds shown at the end

/**
 * Download a file from S3 or URL to a local temp path.
 */
async function downloadToTemp(urlOrS3Key, extension) {
  const tmpPath = path.join(os.tmpdir(), `surepath_${Date.now()}_${Math.random().toString(36).slice(2)}${extension}`);

  // Local file reference — just copy it
  if (urlOrS3Key.startsWith('/') && fs.existsSync(urlOrS3Key)) {
    fs.copyFileSync(urlOrS3Key, tmpPath);
    return tmpPath;
  }

  // Our own content URLs — resolve to local path instead of HTTP fetching
  if (urlOrS3Key.includes('surepath.co.za/content/')) {
    const relPath = urlOrS3Key.split('surepath.co.za/content/')[1];
    const localPath = path.resolve(__dirname, 'dashboard', 'public', 'content', relPath);
    if (fs.existsSync(localPath)) {
      fs.copyFileSync(localPath, tmpPath);
      return tmpPath;
    }
  }

  // Relative URLs for property-images served by dashboard/public/property-images
  if (urlOrS3Key.startsWith('/property-images/')) {
    const localPath = path.resolve(__dirname, 'dashboard', 'public', urlOrS3Key.replace(/^\//, ''));
    if (fs.existsSync(localPath)) {
      fs.copyFileSync(localPath, tmpPath);
      return tmpPath;
    }
  }

  // HTTP(S) download
  return new Promise((resolve, reject) => {
    const mod = urlOrS3Key.startsWith('https') ? https : http;
    mod.get(urlOrS3Key, { headers: { 'User-Agent': 'SurePath/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        downloadToTemp(res.headers.location, extension).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} downloading ${urlOrS3Key}`));
        return;
      }
      const ws = fs.createWriteStream(tmpPath);
      res.pipe(ws);
      ws.on('finish', () => resolve(tmpPath));
      ws.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Write SRT content to a temp file.
 */
function writeSRTToTemp(srtContent) {
  const tmpPath = path.join(os.tmpdir(), `surepath_${Date.now()}.srt`);
  fs.writeFileSync(tmpPath, srtContent, 'utf8');
  return tmpPath;
}

/**
 * Clean up temp files.
 */
function cleanup(...paths) {
  for (const p of paths) {
    try { if (p && fs.existsSync(p)) fs.unlinkSync(p); }
    catch (e) { console.warn(`[compose] cleanup failed for ${p}: ${e.message}`); }
  }
}

/**
 * Download property photos for a property, return array of local temp paths.
 * Falls back to branded background if no photos available.
 */
async function downloadPropertyPhotos(propertyId, maxPhotos = 4) {
  if (!propertyId) return [];

  const rows = await pool.query(
    `SELECT image_url FROM property_images
     WHERE property_id = $1 AND source IN ('property24','privateproperty')
     ORDER BY id LIMIT $2`,
    [propertyId, maxPhotos]
  );

  const paths = [];
  for (const row of rows) {
    try {
      const ext = row.image_url.includes('.png') ? '.png' : '.jpg';
      const p = await downloadToTemp(row.image_url, ext);
      paths.push(p);
      console.log(`[compose] Downloaded photo: ${row.image_url.substring(0, 80)}...`);
    } catch (e) {
      console.warn(`[compose] Failed to download photo: ${e.message}`);
    }
  }
  return paths;
}

/**
 * Generate a branded background image (1080x1920) using FFmpeg.
 * Dark background with Surepath red accent bar.
 */
function generateBrandedBackground() {
  const tmpPath = path.join(os.tmpdir(), `surepath_bg_${Date.now()}.png`);
  // Dark background with red accent bar at top
  execSync(
    `ffmpeg -y -f lavfi -i "color=c=${BRAND_DARK.replace('#', '0x')}:s=1080x1920:d=1" ` +
    `-vf "drawbox=x=0:y=0:w=1080:h=8:color=${BRAND_RED.replace('#', '0x')}:t=fill" ` +
    `-frames:v 1 "${tmpPath}"`,
    { stdio: 'pipe' }
  );
  return tmpPath;
}

/**
 * Compose a 10-second reel video from property photos + audio + captions.
 *
 * Visual: photos crossfade as slideshow (or branded bg if no photos),
 * branded caption bar at bottom, Surepath logo watermark, name card first 3s.
 *
 * @param {string} audioUrl - S3 URL of the voiceover MP3
 * @param {string} srtContent - SRT caption content string
 * @param {number|null} propertyId - property ID for fetching photos (optional)
 * @param {string} hookText - hook text for the opening title card
 * @param {string} outputName - Output filename (without extension)
 * @param {number} [postId] - content_posts.id to update
 * @param {Array} [shotList] - Optional timed shot list from visuals.js
 * @returns {string} S3 URL of the final video
 */
async function composeVideo(audioUrl, srtContent, propertyId, hookText, outputName, postId, shotList) {
  console.log(`[compose] Starting composition: ${outputName}`);

  // Verify FFmpeg is available
  try {
    execSync('ffmpeg -version', { stdio: 'pipe' });
  } catch {
    throw new Error('FFmpeg is not installed or not in PATH');
  }

  // Download audio
  const audioPath = await downloadToTemp(audioUrl, '.mp3');

  // Get audio duration
  let audioDuration;
  try {
    const probe = execSync(
      `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${audioPath}"`,
      { encoding: 'utf8' }
    ).trim();
    audioDuration = parseFloat(probe) || 12;
  } catch {
    audioDuration = 12;
  }
  console.log(`[compose] Audio duration: ${audioDuration}s`);

  const srtPath = writeSRTToTemp(srtContent);
  const outputPath = path.join(os.tmpdir(), `surepath_final_${Date.now()}.mp4`);

  // ─── Resolve shot list → list of local file paths with durations ───
  // If a shot list was provided (from visuals.js), use it.
  // Otherwise fall back to the legacy behaviour: property photos slideshow.
  const shots = [];  // { path, durationSec, isVideo }

  if (shotList && shotList.length > 0) {
    console.log(`[compose] Using shot list with ${shotList.length} shots`);
    for (const s of shotList) {
      const durSec = Math.max(0.5, (s.endMs - s.startMs) / 1000);
      const isVideo = s.type === 'stock';
      const ext = isVideo ? '.mp4' : (s.url.includes('.png') ? '.png' : '.jpg');
      try {
        const p = await downloadToTemp(s.url, ext);
        shots.push({ path: p, durationSec: durSec, isVideo });
        console.log(`  [shot] ${s.type} ${durSec.toFixed(1)}s — ${(s.description || '').substring(0, 60)}`);
      } catch (e) {
        console.warn(`  [shot] Failed to download ${s.url.substring(0, 80)}: ${e.message}`);
      }
    }
  }

  // Legacy fallback: property photos only
  let photos = [];
  if (shots.length === 0) {
    photos = await downloadPropertyPhotos(propertyId);
    for (const p of photos) {
      shots.push({ path: p, durationSec: audioDuration / Math.max(photos.length, 1), isVideo: false });
    }
  }

  const hasPhotos = shots.length > 0;

  // Load logo from local file
  let logoPath = null;
  try {
    if (fs.existsSync(LOGO_PATH)) {
      logoPath = LOGO_PATH;
    } else {
      console.warn(`[compose] Logo not found at ${LOGO_PATH} — composing without watermark`);
    }
  } catch {
    console.warn('[compose] Logo not found — composing without watermark');
  }

  // Generate branded background
  const bgPath = generateBrandedBackground();

  console.log(`[compose] Photos: ${photos.length}, Logo: ${!!logoPath}, Duration: ${audioDuration}s`);

  // Escape SRT path for FFmpeg subtitles filter
  const escapedSrt = srtPath.replace(/'/g, "'\\''").replace(/:/g, '\\:');

  // Caption style — bold white text on semi-transparent dark bar at bottom
  const captionStyle = "FontSize=24,FontName=Arial,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=2,Bold=1,Alignment=2,MarginV=160,BackColour=&H80000000";

  let cmd;

  if (hasPhotos) {
    // ─── SHOT-LIST SLIDESHOW MODE (photos + stock clips mixed) ───

    // Build input flags — for videos, use -t to trim; for photos, -loop 1 -t for still frames
    let inputs = '';
    shots.forEach((s) => {
      if (s.isVideo) {
        inputs += `-t ${s.durationSec.toFixed(2)} -i "${s.path}" `;
      } else {
        inputs += `-loop 1 -t ${s.durationSec.toFixed(2)} -i "${s.path}" `;
      }
    });
    inputs += `-i "${audioPath}"`;
    if (logoPath) inputs += ` -i "${logoPath}"`;

    const audioIdx = shots.length;
    const logoIdx = shots.length + 1;

    let filter = '';

    // Normalise each shot to 1080x1920, strip audio.
    // First shot: NO fade-in (must hit viewers with a bold image immediately).
    // Other shots: quick 0.15s fade-in for smooth crossfade feel (no black flash).
    shots.forEach((s, i) => {
      const isFirst = i === 0;
      const fadeIn = isFirst ? '' : `,fade=t=in:st=0:d=0.15`;
      filter += `[${i}:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30${fadeIn}[s${i}];`;
    });

    // Concatenate all shots
    shots.forEach((_, i) => { filter += `[s${i}]`; });
    filter += `concat=n=${shots.length}:v=1:a=0[slideshow];`;

    // Add branded bar at bottom (dark strip behind captions)
    filter += `[slideshow]drawbox=x=0:y=ih-240:w=iw:h=240:color=${BRAND_DARK.replace('#', '0x')}@0.7:t=fill[barred];`;

    // Add red accent line above the bar
    filter += `[barred]drawbox=x=0:y=ih-240:w=iw:h=4:color=${BRAND_RED.replace('#', '0x')}:t=fill[accented];`;

    // Add name card for first 3 seconds
    filter += `[accented]drawtext=text='Nico | Surepath':fontcolor=white:fontsize=28:font=Arial:x=(w-text_w)/2:y=80:enable='between(t\\,0\\,3)':box=1:boxcolor=${BRAND_DARK.replace('#', '0x')}@0.7:boxborderw=12[named];`;

    // Add captions
    filter += `[named]subtitles='${escapedSrt}':force_style='${captionStyle}'[captioned];`;

    // Add WhatsApp banner for the final WHATSAPP_BANNER_DURATION seconds
    const bannerStart = Math.max(0, audioDuration - WHATSAPP_BANNER_DURATION);
    const waNumber = WHATSAPP_NUMBER.replace(/'/g, "\\'");
    // Full-height green banner covering the whole frame during the last 3 seconds.
    // Covers any lingering captions and gives the contact info the entire screen.
    filter += `[captioned]drawbox=x=0:y=0:w=iw:h=ih:color=${WHATSAPP_GREEN.replace('#', '0x')}@0.97:t=fill:enable='gte(t\\,${bannerStart.toFixed(2)})'[wabox];`;
    filter += `[wabox]drawtext=text='WhatsApp Nico':fontcolor=white:fontsize=64:font=Arial:x=(w-text_w)/2:y=h*0.32:enable='gte(t\\,${bannerStart.toFixed(2)})'[walabel];`;
    filter += `[walabel]drawtext=text='${waNumber}':fontcolor=white:fontsize=110:font=Arial:x=(w-text_w)/2:y=h*0.43:enable='gte(t\\,${bannerStart.toFixed(2)})'[wanum];`;
    filter += `[wanum]drawtext=text='Send a property listing for your Surepath report':fontcolor=white:fontsize=36:font=Arial:x=(w-text_w)/2:y=h*0.58:enable='gte(t\\,${bannerStart.toFixed(2)})'[wacta];`;

    // Add logo watermark if available
    if (logoPath) {
      filter += `[${logoIdx}:v]scale=100:-1,format=rgba,colorchannelmixer=aa=0.15[logo];`;
      filter += `[wacta][logo]overlay=W-w-24:24[final]`;
    } else {
      filter += `[wacta]copy[final]`;
    }

    cmd = `ffmpeg -y ${inputs} -filter_complex "${filter}" -map "[final]" -map ${audioIdx}:a -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -movflags +faststart -shortest -r 30 "${outputPath}" 2>&1`;

  } else {
    // ─── BRANDED BACKGROUND MODE (no photos) ───
    // Static branded bg with hook text, captions, and voiceover
    let inputs = `-loop 1 -t ${audioDuration.toFixed(2)} -i "${bgPath}" -i "${audioPath}"`;
    if (logoPath) inputs += ` -i "${logoPath}"`;

    const safeHook = (hookText || 'Surepath').replace(/'/g, "\u2019").replace(/:/g, '\\:').replace(/\\/g, '\\\\');

    let filter = '';
    // Scale bg
    filter += `[0:v]scale=1080:1920[bg];`;

    // Add branded bar at bottom
    filter += `[bg]drawbox=x=0:y=ih-240:w=iw:h=240:color=${BRAND_DARK.replace('#', '0x')}@0.7:t=fill[barred];`;
    filter += `[barred]drawbox=x=0:y=ih-240:w=iw:h=4:color=${BRAND_RED.replace('#', '0x')}:t=fill[accented];`;

    // Hook text large in centre
    filter += `[accented]drawtext=text='${safeHook}':fontcolor=white:fontsize=42:font=Arial:x=(w-text_w)/2:y=(h-text_h)/2-60:enable='between(t\\,0\\,${audioDuration.toFixed(2)})':line_spacing=12[hooked];`;

    // Name card first 3 seconds
    filter += `[hooked]drawtext=text='Nico | Surepath':fontcolor=white:fontsize=28:font=Arial:x=(w-text_w)/2:y=80:enable='between(t\\,0\\,3)':box=1:boxcolor=${BRAND_DARK.replace('#', '0x')}@0.7:boxborderw=12[named];`;

    // Captions
    filter += `[named]subtitles='${escapedSrt}':force_style='${captionStyle}'[captioned];`;

    // WhatsApp banner for the final seconds
    const bannerStart = Math.max(0, audioDuration - WHATSAPP_BANNER_DURATION);
    const waNumber = WHATSAPP_NUMBER.replace(/'/g, "\\'");
    // Full-height green banner covering the whole frame during the last 3 seconds.
    // Covers any lingering captions and gives the contact info the entire screen.
    filter += `[captioned]drawbox=x=0:y=0:w=iw:h=ih:color=${WHATSAPP_GREEN.replace('#', '0x')}@0.97:t=fill:enable='gte(t\\,${bannerStart.toFixed(2)})'[wabox];`;
    filter += `[wabox]drawtext=text='WhatsApp Nico':fontcolor=white:fontsize=64:font=Arial:x=(w-text_w)/2:y=h*0.32:enable='gte(t\\,${bannerStart.toFixed(2)})'[walabel];`;
    filter += `[walabel]drawtext=text='${waNumber}':fontcolor=white:fontsize=110:font=Arial:x=(w-text_w)/2:y=h*0.43:enable='gte(t\\,${bannerStart.toFixed(2)})'[wanum];`;
    filter += `[wanum]drawtext=text='Send a property listing for your Surepath report':fontcolor=white:fontsize=36:font=Arial:x=(w-text_w)/2:y=h*0.58:enable='gte(t\\,${bannerStart.toFixed(2)})'[wacta];`;

    // Logo
    if (logoPath) {
      filter += `[2:v]scale=100:-1,format=rgba,colorchannelmixer=aa=0.15[logo];`;
      filter += `[wacta][logo]overlay=W-w-24:24[final]`;
    } else {
      filter += `[wacta]copy[final]`;
    }

    cmd = `ffmpeg -y ${inputs} -filter_complex "${filter}" -map "[final]" -map 1:a -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -movflags +faststart -shortest -r 30 "${outputPath}" 2>&1`;
  }

  console.log(`[compose] FFmpeg command length: ${cmd.length} chars`);

  try {
    execSync(cmd, { stdio: 'pipe', maxBuffer: 50 * 1024 * 1024, timeout: 300000 });
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString().slice(-500) : err.message;
    console.warn(`[compose] Complex filter failed, trying simple fallback: ${stderr}`);

    // Simple fallback: just audio + branded bg + captions
    const fallbackCmd = `ffmpeg -y -loop 1 -t ${audioDuration.toFixed(2)} -i "${bgPath}" -i "${audioPath}" -vf "scale=1080:1920,subtitles='${escapedSrt}':force_style='FontSize=24,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=2,Bold=1,Alignment=2,MarginV=120'" -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -movflags +faststart -shortest -r 30 "${outputPath}" 2>&1`;

    execSync(fallbackCmd, { stdio: 'pipe', maxBuffer: 50 * 1024 * 1024, timeout: 300000 });
  }

  // Verify output exists
  if (!fs.existsSync(outputPath)) {
    throw new Error('FFmpeg produced no output');
  }

  const fileSize = fs.statSync(outputPath).size;
  console.log(`[compose] Output: ${outputPath} (${Math.round(fileSize / 1024)}KB)`);

  // Save locally — served at https://surepath.co.za/content/video/...
  const { url } = saveFile(outputPath, 'video', `${outputName}.mp4`);
  console.log(`[compose] Saved: ${url}`);

  if (postId) {
    await pool.query('UPDATE content_posts SET final_video_url = $1 WHERE id = $2', [url, postId]);
  }

  // Cleanup (skip logoPath — it's the source logo, not a temp)
  cleanup(audioPath, srtPath, outputPath, bgPath, ...photos, ...shots.map((s) => s.path));

  return url;
}

module.exports = { composeVideo, downloadToTemp, writeSRTToTemp, downloadPropertyPhotos };
