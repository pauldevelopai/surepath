const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const pool = require('./db');

const S3_BUCKET = process.env.AWS_S3_BUCKET || 'surepath-reports';
const AWS_REGION = process.env.AWS_REGION || 'af-south-1';
const s3 = new S3Client({ region: AWS_REGION });

const LOGO_S3_KEY = process.env.SUREPATH_LOGO_S3_KEY || 'assets/surepath-logo.png';

/**
 * Download a file from S3 or URL to a local temp path.
 */
async function downloadToTemp(urlOrS3Key, extension) {
  const tmpPath = path.join(os.tmpdir(), `surepath_${Date.now()}_${Math.random().toString(36).slice(2)}${extension}`);

  // If it's an S3 URL for our bucket, use GetObject
  if (urlOrS3Key.includes(S3_BUCKET)) {
    const key = urlOrS3Key.split('.amazonaws.com/')[1];
    if (key) {
      const res = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
      const chunks = [];
      for await (const chunk of res.Body) {
        chunks.push(chunk);
      }
      fs.writeFileSync(tmpPath, Buffer.concat(chunks));
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
 * Compose final video with captions, logo, and name card.
 *
 * @param {string} avatarVideoUrl - S3 URL of the avatar video
 * @param {string} srtContent - SRT caption content string
 * @param {string} [backgroundAsset] - S3 URL of background (optional)
 * @param {string} outputName - Output filename (without extension)
 * @param {number} [postId] - content_posts.id to update
 * @returns {string} S3 URL of the final video
 */
async function composeVideo(avatarVideoUrl, srtContent, backgroundAsset, outputName, postId) {
  console.log(`[compose] Starting composition: ${outputName}`);

  // Verify FFmpeg is available
  try {
    execSync('ffmpeg -version', { stdio: 'pipe' });
  } catch {
    throw new Error('FFmpeg is not installed or not in PATH');
  }

  // Download files to temp
  const avatarPath = await downloadToTemp(avatarVideoUrl, '.mp4');
  const srtPath = writeSRTToTemp(srtContent);
  const outputPath = path.join(os.tmpdir(), `surepath_final_${Date.now()}.mp4`);

  let bgPath = null;
  let logoPath = null;

  // Try to download background asset
  if (backgroundAsset) {
    try {
      bgPath = await downloadToTemp(backgroundAsset, '.mp4');
    } catch (e) {
      console.warn(`[compose] Background download failed: ${e.message}`);
    }
  }

  // Try to download logo
  try {
    logoPath = await downloadToTemp(
      `https://${S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com/${LOGO_S3_KEY}`,
      '.png'
    );
  } catch {
    console.warn('[compose] Logo not found — composing without watermark');
  }

  console.log(`[compose] Files ready. Running FFmpeg...`);

  // Build FFmpeg filter complex
  // Captions: white text, black outline, bottom third
  // Logo: bottom right, 10% opacity
  // Name card: first 3 seconds, lower third
  let filterComplex = '';
  let inputs = `-i "${avatarPath}"`;
  let inputIdx = 0;

  if (bgPath) {
    inputs += ` -i "${bgPath}"`;
    inputIdx++;
  }

  if (logoPath) {
    inputs += ` -i "${logoPath}"`;
  }

  // Base: scale avatar to 1080x1920 vertical
  filterComplex += `[0:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black[base];`;

  // Add captions (subtitles filter with SRT)
  // Style: white, bold, black outline, bottom area
  const escapedSrt = srtPath.replace(/'/g, "'\\''").replace(/:/g, '\\:');
  filterComplex += `[base]subtitles='${escapedSrt}':force_style='FontSize=22,FontName=Arial,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=2,Bold=1,Alignment=2,MarginV=120'[captioned];`;

  // Add name card for first 3 seconds
  filterComplex += `[captioned]drawtext=text='Nico | Surepath':fontcolor=white:fontsize=28:font=Arial:x=(w-text_w)/2:y=h-200:enable='between(t\\,0\\,3)':box=1:boxcolor=black@0.6:boxborderw=10[named];`;

  // Add logo watermark if available
  if (logoPath) {
    const logoIdx = bgPath ? 2 : 1;
    filterComplex += `[${logoIdx}:v]scale=120:-1,format=rgba,colorchannelmixer=aa=0.1[logo];`;
    filterComplex += `[named][logo]overlay=W-w-30:H-h-30[final]`;
  } else {
    filterComplex += `[named]copy[final]`;
  }

  const cmd = `ffmpeg -y ${inputs} -filter_complex "${filterComplex}" -map "[final]" -map 0:a -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -movflags +faststart -r 30 "${outputPath}" 2>&1`;

  console.log(`[compose] FFmpeg command length: ${cmd.length} chars`);

  try {
    execSync(cmd, { stdio: 'pipe', maxBuffer: 50 * 1024 * 1024, timeout: 300000 });
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString().slice(-500) : err.message;
    // Try simpler pipeline without logo/namecard if complex fails
    console.warn(`[compose] Complex filter failed, trying simple: ${stderr}`);

    const simpleCmd = `ffmpeg -y -i "${avatarPath}" -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,subtitles='${escapedSrt}':force_style='FontSize=22,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=2,Bold=1,Alignment=2,MarginV=120'" -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -movflags +faststart -r 30 "${outputPath}" 2>&1`;

    execSync(simpleCmd, { stdio: 'pipe', maxBuffer: 50 * 1024 * 1024, timeout: 300000 });
  }

  // Verify output exists
  if (!fs.existsSync(outputPath)) {
    throw new Error('FFmpeg produced no output');
  }

  const fileSize = fs.statSync(outputPath).size;
  console.log(`[compose] Output: ${outputPath} (${Math.round(fileSize / 1024)}KB)`);

  // Upload to S3
  const s3Key = `content/final/${outputName}.mp4`;
  const fileBuffer = fs.readFileSync(outputPath);

  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: s3Key,
    Body: fileBuffer,
    ContentType: 'video/mp4',
  }));

  const s3Url = `https://${S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com/${s3Key}`;
  console.log(`[compose] Uploaded: ${s3Url}`);

  // Update content_posts
  if (postId) {
    await pool.query('UPDATE content_posts SET final_video_url = $1 WHERE id = $2', [s3Url, postId]);
  }

  // Cleanup
  cleanup(avatarPath, srtPath, outputPath, bgPath, logoPath);

  return s3Url;
}

module.exports = { composeVideo, downloadToTemp, writeSRTToTemp };
