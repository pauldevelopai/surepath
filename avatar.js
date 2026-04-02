const https = require('https');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const pool = require('./db');

const HEYGEN_API_KEY = process.env.HEYGEN_API_KEY;
const S3_BUCKET = process.env.AWS_S3_BUCKET || 'surepath-reports';
const AWS_REGION = process.env.AWS_REGION || 'af-south-1';
const s3 = new S3Client({ region: AWS_REGION });

const DEFAULT_AVATAR_ID = process.env.HEYGEN_AVATAR_ID || 'Daisy-inskirt-20220818';
const POLL_INTERVAL_MS = 15000;
const TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Make an HTTPS JSON request to HeyGen API.
 */
function heygenRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.heygen.com',
      path,
      method,
      headers: {
        'X-Api-Key': HEYGEN_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HeyGen ${res.statusCode}: ${data}`));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`HeyGen invalid JSON: ${data.substring(0, 200)}`)); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

/**
 * Download a file from a URL and return as Buffer.
 */
function downloadBuffer(url) {
  const mod = url.startsWith('https') ? https : require('http');
  return new Promise((resolve, reject) => {
    mod.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadBuffer(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        let body = '';
        res.on('data', (c) => body += c);
        res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${body.substring(0, 200)}`)));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Poll HeyGen until video is complete or timeout.
 */
async function pollVideoStatus(videoId) {
  const startTime = Date.now();

  while (Date.now() - startTime < TIMEOUT_MS) {
    const res = await heygenRequest('GET', `/v1/video_status.get?video_id=${videoId}`);
    const status = res.data?.status;

    console.log(`[avatar] Poll: status=${status}`);

    if (status === 'completed') {
      return res.data.video_url;
    }
    if (status === 'failed') {
      throw new Error(`HeyGen video failed: ${res.data?.error || 'unknown'}`);
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  throw new Error('HeyGen video generation timed out after 10 minutes');
}

/**
 * Generate an avatar video from an audio URL.
 *
 * @param {string} audioS3Url - S3 URL of the audio file
 * @param {string} [avatarId] - HeyGen avatar ID
 * @param {number} [postId] - content_posts.id to update
 * @returns {string} S3 URL of the avatar video
 */
async function generateAvatar(audioS3Url, avatarId, postId) {
  if (!HEYGEN_API_KEY) throw new Error('HEYGEN_API_KEY not set');

  const avId = avatarId || DEFAULT_AVATAR_ID;
  console.log(`[avatar] Generating video (avatar=${avId})...`);

  // Submit video generation
  const submitRes = await heygenRequest('POST', '/v2/video/generate', {
    video_inputs: [{
      character: {
        type: 'avatar',
        avatar_id: avId,
        avatar_style: 'normal',
      },
      voice: {
        type: 'audio',
        audio_url: audioS3Url,
      },
    }],
    dimension: {
      width: 1080,
      height: 1920,
    },
  });

  const videoId = submitRes.data?.video_id;
  if (!videoId) throw new Error(`HeyGen no video_id: ${JSON.stringify(submitRes)}`);

  console.log(`[avatar] Video submitted: ${videoId}`);

  // Poll until complete
  const videoUrl = await pollVideoStatus(videoId);
  console.log(`[avatar] Video ready: ${videoUrl}`);

  // Download and upload to S3
  const videoBuffer = await downloadBuffer(videoUrl);
  const timestamp = Date.now();
  const s3Key = `content/avatar/${timestamp}.mp4`;

  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: s3Key,
    Body: videoBuffer,
    ContentType: 'video/mp4',
  }));

  const s3Url = `https://${S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com/${s3Key}`;
  console.log(`[avatar] Uploaded: ${s3Url} (${videoBuffer.length} bytes)`);

  if (postId) {
    await pool.query('UPDATE content_posts SET avatar_video_url = $1 WHERE id = $2', [s3Url, postId]);
  }

  return s3Url;
}

module.exports = { generateAvatar, heygenRequest, pollVideoStatus };
