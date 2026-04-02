const https = require('https');
const pool = require('./db');

const INSTAGRAM_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
const INSTAGRAM_USER_ID = process.env.INSTAGRAM_USER_ID;
const TIKTOK_ACCESS_TOKEN = process.env.TIKTOK_ACCESS_TOKEN;
const YOUTUBE_CLIENT_ID = process.env.YOUTUBE_CLIENT_ID;
const YOUTUBE_CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;
const YOUTUBE_REFRESH_TOKEN = process.env.YOUTUBE_REFRESH_TOKEN;

const POLL_INTERVAL_MS = 10000;
const TIMEOUT_MS = 5 * 60 * 1000;

// ─── HTTP helpers ──────────────────────────────────────────────────────

function httpsJson(method, hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'SurePath/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadBuffer(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        let body = '';
        res.on('data', (c) => body += c);
        res.on('end', () => reject(new Error(`HTTP ${res.statusCode}`)));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ─── Instagram (Graph API) ─────────────────────────────────────────────

async function publishInstagram(videoUrl, caption) {
  if (!INSTAGRAM_ACCESS_TOKEN || !INSTAGRAM_USER_ID) {
    console.warn('[publish] Instagram: credentials not set — skipping');
    return null;
  }

  console.log('[publish] Instagram: creating media container...');

  // Step 1: Create media container
  const createRes = await httpsJson('POST', 'graph.facebook.com',
    `/v19.0/${INSTAGRAM_USER_ID}/media`, {},
    {
      media_type: 'REELS',
      video_url: videoUrl,
      caption,
      share_to_feed: true,
      access_token: INSTAGRAM_ACCESS_TOKEN,
    }
  );

  if (createRes.status !== 200 || !createRes.body.id) {
    throw new Error(`Instagram create failed: ${JSON.stringify(createRes.body)}`);
  }

  const creationId = createRes.body.id;
  console.log(`[publish] Instagram: container ${creationId}`);

  // Step 2: Poll until FINISHED
  const startTime = Date.now();
  while (Date.now() - startTime < TIMEOUT_MS) {
    const statusRes = await httpsJson('GET', 'graph.facebook.com',
      `/v19.0/${creationId}?fields=status_code&access_token=${INSTAGRAM_ACCESS_TOKEN}`, {});

    const status = statusRes.body?.status_code;
    console.log(`[publish] Instagram poll: ${status}`);

    if (status === 'FINISHED') break;
    if (status === 'ERROR') throw new Error('Instagram media processing failed');

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  // Step 3: Publish
  const publishRes = await httpsJson('POST', 'graph.facebook.com',
    `/v19.0/${INSTAGRAM_USER_ID}/media_publish`, {},
    {
      creation_id: creationId,
      access_token: INSTAGRAM_ACCESS_TOKEN,
    }
  );

  if (publishRes.status !== 200 || !publishRes.body.id) {
    throw new Error(`Instagram publish failed: ${JSON.stringify(publishRes.body)}`);
  }

  console.log(`[publish] Instagram: published ${publishRes.body.id}`);
  return publishRes.body.id;
}

// ─── TikTok (Content Posting API) ──────────────────────────────────────

async function publishTikTok(videoUrl, caption) {
  if (!TIKTOK_ACCESS_TOKEN) {
    console.warn('[publish] TikTok: credentials not set — skipping');
    return null;
  }

  console.log('[publish] TikTok: initiating upload...');

  // Step 1: Init video post
  const initRes = await httpsJson('POST', 'open.tiktokapis.com',
    '/v2/post/publish/video/init/',
    { 'Authorization': `Bearer ${TIKTOK_ACCESS_TOKEN}` },
    {
      post_info: {
        title: caption.substring(0, 150),
        privacy_level: 'PUBLIC_TO_EVERYONE',
      },
      source_info: {
        source: 'PULL_FROM_URL',
        video_url: videoUrl,
      },
    }
  );

  if (initRes.body?.error?.code !== 'ok' && !initRes.body?.data?.publish_id) {
    throw new Error(`TikTok init failed: ${JSON.stringify(initRes.body)}`);
  }

  const publishId = initRes.body.data?.publish_id;
  console.log(`[publish] TikTok: publish_id ${publishId}`);

  // Step 2: Poll status
  const startTime = Date.now();
  while (Date.now() - startTime < TIMEOUT_MS) {
    const statusRes = await httpsJson('POST', 'open.tiktokapis.com',
      '/v2/post/publish/status/fetch/',
      { 'Authorization': `Bearer ${TIKTOK_ACCESS_TOKEN}` },
      { publish_id: publishId }
    );

    const status = statusRes.body?.data?.status;
    console.log(`[publish] TikTok poll: ${status}`);

    if (status === 'PUBLISH_COMPLETE') {
      return publishId;
    }
    if (status === 'FAILED') {
      throw new Error(`TikTok publish failed: ${JSON.stringify(statusRes.body)}`);
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  console.warn('[publish] TikTok: timed out waiting — video may still be processing');
  return publishId;
}

// ─── YouTube (Data API v3) ─────────────────────────────────────────────

async function getYouTubeAccessToken() {
  const res = await httpsJson('POST', 'oauth2.googleapis.com', '/token', {},
    {
      client_id: YOUTUBE_CLIENT_ID,
      client_secret: YOUTUBE_CLIENT_SECRET,
      refresh_token: YOUTUBE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }
  );

  if (!res.body?.access_token) {
    throw new Error(`YouTube token refresh failed: ${JSON.stringify(res.body)}`);
  }

  return res.body.access_token;
}

async function publishYouTube(videoUrl, title, description) {
  if (!YOUTUBE_CLIENT_ID || !YOUTUBE_CLIENT_SECRET || !YOUTUBE_REFRESH_TOKEN) {
    console.warn('[publish] YouTube: credentials not set — skipping');
    return null;
  }

  console.log('[publish] YouTube: refreshing token...');
  const accessToken = await getYouTubeAccessToken();

  // Download video for upload
  console.log('[publish] YouTube: downloading video...');
  const videoBuffer = await downloadBuffer(videoUrl);

  console.log(`[publish] YouTube: uploading ${Math.round(videoBuffer.length / 1024)}KB...`);

  // Metadata
  const metadata = JSON.stringify({
    snippet: {
      title,
      description,
      tags: ['property', 'South Africa', 'real estate', 'Surepath', 'home buying'],
      categoryId: '22', // People & Blogs
    },
    status: {
      privacyStatus: 'public',
      selfDeclaredMadeForKids: false,
    },
  });

  // Multipart upload
  const boundary = `surepath_${Date.now()}`;
  const CRLF = '\r\n';

  const preamble = Buffer.from(
    `--${boundary}${CRLF}` +
    `Content-Type: application/json; charset=UTF-8${CRLF}${CRLF}` +
    metadata +
    `${CRLF}--${boundary}${CRLF}` +
    `Content-Type: video/mp4${CRLF}${CRLF}`
  );

  const epilogue = Buffer.from(`${CRLF}--${boundary}--`);
  const fullBody = Buffer.concat([preamble, videoBuffer, epilogue]);

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'www.googleapis.com',
      path: '/upload/youtube/v3/videos?uploadType=multipart&part=snippet,status',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
        'Content-Length': fullBody.length,
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.id) {
            console.log(`[publish] YouTube: published ${parsed.id}`);
            resolve(parsed.id);
          } else {
            reject(new Error(`YouTube upload failed: ${data.substring(0, 300)}`));
          }
        } catch {
          reject(new Error(`YouTube response: ${data.substring(0, 300)}`));
        }
      });
      res.on('error', reject);
    });

    req.on('error', reject);
    req.write(fullBody);
    req.end();
  });
}

// ─── Publish to all platforms ──────────────────────────────────────────

/**
 * Publish a video to Instagram, TikTok, and YouTube simultaneously.
 *
 * @param {string} videoS3Url - S3 URL of the final video
 * @param {string} captionText - Caption / description
 * @param {number} postId - content_posts.id to update
 * @returns {{ instagram_post_id, tiktok_post_id, youtube_post_id }}
 */
async function publishToAll(videoS3Url, captionText, postId) {
  console.log(`[publish] Publishing to all platforms (post ${postId})...`);

  const title = captionText.split('\n')[0].substring(0, 100) || 'Surepath Property Intel';
  const shortCaption = captionText.substring(0, 2200); // Instagram limit

  // Run all three in parallel
  const [instagramId, tiktokId, youtubeId] = await Promise.all([
    publishInstagram(videoS3Url, shortCaption).catch((err) => {
      console.error('[publish] Instagram failed:', err.message);
      return null;
    }),
    publishTikTok(videoS3Url, shortCaption).catch((err) => {
      console.error('[publish] TikTok failed:', err.message);
      return null;
    }),
    publishYouTube(videoS3Url, title, captionText).catch((err) => {
      console.error('[publish] YouTube failed:', err.message);
      return null;
    }),
  ]);

  // Update content_posts
  if (postId) {
    await pool.query(
      `UPDATE content_posts SET
         instagram_post_id = COALESCE($1, instagram_post_id),
         tiktok_post_id = COALESCE($2, tiktok_post_id),
         youtube_post_id = COALESCE($3, youtube_post_id),
         status = 'posted',
         posted_at = NOW()
       WHERE id = $4`,
      [instagramId, tiktokId, youtubeId, postId]
    );
  }

  const result = {
    instagram_post_id: instagramId,
    tiktok_post_id: tiktokId,
    youtube_post_id: youtubeId,
  };

  console.log('[publish] Complete:', result);
  return result;
}

module.exports = {
  publishToAll,
  publishInstagram,
  publishTikTok,
  publishYouTube,
};
