/**
 * TikTok Content Posting API integration.
 * OAuth token management + video upload via PULL_FROM_URL.
 *
 * Required env vars:
 *   TIKTOK_CLIENT_KEY
 *   TIKTOK_CLIENT_SECRET
 *   TIKTOK_REDIRECT_URI (e.g. https://surepath.co.za/api/tiktok/callback)
 */
const https = require('https');
const pool = require('./db');

const TIKTOK_CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY;
const TIKTOK_CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET;
const TIKTOK_REDIRECT_URI = process.env.TIKTOK_REDIRECT_URI || 'https://surepath.co.za/api/tiktok/callback';

// Scopes — user.info.basic is auto-approved; video.upload/video.publish require
// Content Posting API approval. If not yet approved, set TIKTOK_SCOPES in .env.local
// to just 'user.info.basic' to test the OAuth handshake first.
const SCOPES = (process.env.TIKTOK_SCOPES || 'user.info.basic').split(',');

function httpsJson(method, hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    let bodyStr = null;
    if (body) {
      bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const options = {
      hostname,
      path,
      method,
      headers: {
        ...headers,
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
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

// ─── OAuth ──────────────────────────────────────────────────────────

function getAuthorizeUrl(state) {
  if (!TIKTOK_CLIENT_KEY) throw new Error('TIKTOK_CLIENT_KEY not set');
  const params = new URLSearchParams({
    client_key: TIKTOK_CLIENT_KEY,
    scope: SCOPES.join(','),
    response_type: 'code',
    redirect_uri: TIKTOK_REDIRECT_URI,
    state: state || Math.random().toString(36).slice(2),
  });
  return `https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`;
}

async function exchangeCodeForToken(code) {
  const body = new URLSearchParams({
    client_key: TIKTOK_CLIENT_KEY,
    client_secret: TIKTOK_CLIENT_SECRET,
    code,
    grant_type: 'authorization_code',
    redirect_uri: TIKTOK_REDIRECT_URI,
  }).toString();

  const res = await httpsJson('POST', 'open.tiktokapis.com', '/v2/oauth/token/',
    { 'Content-Type': 'application/x-www-form-urlencoded' }, body);

  if (res.status !== 200 || !res.body.access_token) {
    throw new Error(`TikTok token exchange failed: ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

async function refreshToken(refresh_token) {
  const body = new URLSearchParams({
    client_key: TIKTOK_CLIENT_KEY,
    client_secret: TIKTOK_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token,
  }).toString();

  const res = await httpsJson('POST', 'open.tiktokapis.com', '/v2/oauth/token/',
    { 'Content-Type': 'application/x-www-form-urlencoded' }, body);

  if (res.status !== 200 || !res.body.access_token) {
    throw new Error(`TikTok refresh failed: ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

async function saveAccount(tokenResponse) {
  const now = Date.now();
  const accessExpires = new Date(now + (tokenResponse.expires_in * 1000));
  const refreshExpires = new Date(now + ((tokenResponse.refresh_expires_in || 0) * 1000));

  await pool.query(
    `INSERT INTO tiktok_accounts
      (open_id, union_id, access_token, refresh_token, access_token_expires_at,
       refresh_token_expires_at, scope, is_active, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, NOW())
     ON CONFLICT (open_id) DO UPDATE SET
       access_token = EXCLUDED.access_token,
       refresh_token = EXCLUDED.refresh_token,
       access_token_expires_at = EXCLUDED.access_token_expires_at,
       refresh_token_expires_at = EXCLUDED.refresh_token_expires_at,
       scope = EXCLUDED.scope,
       is_active = TRUE,
       updated_at = NOW()`,
    [
      tokenResponse.open_id,
      tokenResponse.union_id || null,
      tokenResponse.access_token,
      tokenResponse.refresh_token || null,
      accessExpires,
      refreshExpires,
      tokenResponse.scope,
    ]
  );
}

/**
 * Get the active TikTok account, refreshing the token if expired.
 */
async function getActiveAccount() {
  const { rows } = await pool.query(
    `SELECT * FROM tiktok_accounts WHERE is_active = TRUE
     ORDER BY updated_at DESC LIMIT 1`
  );
  if (rows.length === 0) return null;

  const account = rows[0];

  // Refresh if expired or expiring within 5 minutes
  const expiresAt = new Date(account.access_token_expires_at).getTime();
  if (expiresAt - Date.now() < 5 * 60 * 1000) {
    console.log('[tiktok] Access token expiring — refreshing...');
    try {
      const refreshed = await refreshToken(account.refresh_token);
      await saveAccount({ ...refreshed, open_id: account.open_id, union_id: account.union_id });
      const fresh = await pool.query('SELECT * FROM tiktok_accounts WHERE open_id = $1', [account.open_id]);
      return fresh.rows[0];
    } catch (e) {
      console.error('[tiktok] Refresh failed:', e.message);
      return null;
    }
  }

  return account;
}

// ─── Publishing ─────────────────────────────────────────────────────

/**
 * Resolve a video URL (hosted at surepath.co.za) to a local file path.
 */
function resolveLocalPath(videoUrl) {
  const path = require('path');
  const fs = require('fs');

  if (videoUrl.startsWith('/') && fs.existsSync(videoUrl)) return videoUrl;

  if (videoUrl.includes('surepath.co.za/content/')) {
    const relPath = videoUrl.split('surepath.co.za/content/')[1];
    const localPath = path.resolve(__dirname, 'dashboard', 'public', 'content', relPath);
    if (fs.existsSync(localPath)) return localPath;
  }
  throw new Error(`Cannot resolve local path for ${videoUrl}`);
}

/**
 * PUT a video file to TikTok's upload URL.
 */
function putVideoFile(uploadUrl, filePath) {
  const fs = require('fs');
  const url = new URL(uploadUrl);
  const stats = fs.statSync(filePath);
  const videoBuffer = fs.readFileSync(filePath);

  return new Promise((resolve, reject) => {
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'PUT',
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': stats.size,
        'Content-Range': `bytes 0-${stats.size - 1}/${stats.size}`,
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(videoBuffer);
    req.end();
  });
}

/**
 * Upload a video to TikTok using FILE_UPLOAD method.
 * Avoids needing URL ownership verification for pull_from_url.
 */
async function uploadVideo(videoUrl, caption) {
  const account = await getActiveAccount();
  if (!account) throw new Error('No active TikTok account — run OAuth flow first');

  // Resolve the hosted URL to a local file path
  const localPath = resolveLocalPath(videoUrl);
  const fs = require('fs');
  const stats = fs.statSync(localPath);
  const videoSize = stats.size;

  console.log(`[tiktok] Uploading ${localPath} (${Math.round(videoSize / 1024)}KB)`);

  // Step 1: init upload with FILE_UPLOAD method
  const initRes = await httpsJson('POST', 'open.tiktokapis.com',
    '/v2/post/publish/video/init/',
    { 'Authorization': `Bearer ${account.access_token}`, 'Content-Type': 'application/json' },
    {
      post_info: {
        title: (caption || '').substring(0, 150),
        // Unaudited apps can only post as SELF_ONLY (private — only poster sees it).
        // Once the app passes TikTok's audit, change to PUBLIC_TO_EVERYONE via TIKTOK_PRIVACY env var.
        privacy_level: process.env.TIKTOK_PRIVACY || 'SELF_ONLY',
        disable_duet: false,
        disable_comment: false,
        disable_stitch: false,
      },
      source_info: {
        source: 'FILE_UPLOAD',
        video_size: videoSize,
        chunk_size: videoSize,
        total_chunk_count: 1,
      },
    }
  );

  if (initRes.status !== 200 || !initRes.body.data?.publish_id) {
    throw new Error(`TikTok init failed: ${JSON.stringify(initRes.body)}`);
  }

  const publishId = initRes.body.data.publish_id;
  const uploadUrl = initRes.body.data.upload_url;
  console.log(`[tiktok] publish_id: ${publishId}`);
  console.log(`[tiktok] upload_url: ${uploadUrl.substring(0, 80)}...`);

  // Step 2: PUT the video file to the upload URL
  const putRes = await putVideoFile(uploadUrl, localPath);
  if (putRes.status < 200 || putRes.status >= 300) {
    throw new Error(`TikTok file upload failed (${putRes.status}): ${putRes.body}`);
  }
  console.log(`[tiktok] file uploaded (HTTP ${putRes.status})`);

  // Step 3: poll status until processing completes
  const timeout = 5 * 60 * 1000;
  const start = Date.now();
  let finalStatus = null;

  while (Date.now() - start < timeout) {
    const statusRes = await httpsJson('POST', 'open.tiktokapis.com',
      '/v2/post/publish/status/fetch/',
      { 'Authorization': `Bearer ${account.access_token}`, 'Content-Type': 'application/json' },
      { publish_id: publishId }
    );

    const status = statusRes.body?.data?.status;
    console.log(`[tiktok] poll: ${status}`);

    if (status === 'PUBLISH_COMPLETE') { finalStatus = 'success'; break; }
    if (status === 'FAILED') { finalStatus = 'failed'; break; }

    await new Promise((r) => setTimeout(r, 5000));
  }

  return { publish_id: publishId, status: finalStatus || 'pending' };
}

module.exports = {
  getAuthorizeUrl,
  exchangeCodeForToken,
  refreshToken,
  saveAccount,
  getActiveAccount,
  uploadVideo,
};
