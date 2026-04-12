/**
 * Trending hashtag scraper for property content.
 * Pulls trending hashtags from TikTok Creative Center (public) filtered
 * for South Africa / real estate, then merges with a curated baseline.
 *
 * Marks old hashtags as inactive if they haven't been refreshed recently.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const https = require('https');
const pool = require('../db');

// Curated SA property hashtag baseline — always present, ensure we never post naked.
const CURATED = [
  { tag: 'surepath', category: 'brand' },
  { tag: 'propertysouthafrica', category: 'property' },
  { tag: 'southafrica', category: 'location' },
  { tag: 'saproperty', category: 'property' },
  { tag: 'propertyadvice', category: 'property' },
  { tag: 'homebuying', category: 'property' },
  { tag: 'propertyinvestment', category: 'property' },
  { tag: 'realestate', category: 'property' },
  { tag: 'realestateSA', category: 'property' },
  { tag: 'capetown', category: 'location' },
  { tag: 'johannesburg', category: 'location' },
  { tag: 'durban', category: 'location' },
  { tag: 'pretoria', category: 'location' },
  { tag: 'propertyinspection', category: 'property' },
  { tag: 'propertyrisk', category: 'property' },
  { tag: 'propertytips', category: 'property' },
  { tag: 'propertyhack', category: 'property' },
  { tag: 'househunting', category: 'property' },
  { tag: 'firsttimebuyer', category: 'property' },
  { tag: 'bondoriginator', category: 'property' },
  { tag: 'transferduty', category: 'property' },
  { tag: 'homeloan', category: 'property' },
  { tag: 'propertyscam', category: 'property' },
  { tag: 'levies', category: 'property' },
  { tag: 'bodycorporate', category: 'property' },
  { tag: 'sectionaltitle', category: 'property' },
  { tag: 'freehold', category: 'property' },
  { tag: 'property24', category: 'property' },
  { tag: 'privateproperty', category: 'property' },
  { tag: 'niconico', category: 'brand' },
  { tag: 'fyp', category: 'tiktok' },
  { tag: 'foryou', category: 'tiktok' },
  { tag: 'foryoupage', category: 'tiktok' },
];

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const options = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-ZA,en;q=0.9',
        ...headers,
      },
    };
    https.get(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGet(res.headers.location, headers).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
      res.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Fetch trending hashtags from TikTok Creative Center public hashtag list.
 * The endpoint is the same one their browser uses — country_code=ZA.
 */
async function fetchTikTokTrending() {
  const industry = 'real_estate';
  const url = `https://ads.tiktok.com/creative_radar_api/v1/popular_trend/hashtag/list?period=7&page=1&limit=30&country_code=ZA&industry_id=${industry}`;

  try {
    const res = await httpsGet(url);
    if (res.status !== 200) {
      console.log(`[trending] TikTok API returned ${res.status} — skipping TikTok source`);
      return [];
    }
    const json = JSON.parse(res.body);
    const list = json?.data?.list || [];
    return list.map((h, i) => ({
      tag: (h.hashtag_name || h.name || '').replace(/^#/, '').trim().toLowerCase(),
      category: 'tiktok_trending',
      rank: i + 1,
      score: Number(h.rank_diff) || 0,
      postCount: Number(h.publish_cnt) || Number(h.video_cnt) || 0,
      source: 'tiktok_creative_center',
    })).filter((h) => h.tag);
  } catch (e) {
    console.log(`[trending] TikTok fetch failed: ${e.message} — skipping TikTok source`);
    return [];
  }
}

async function upsertHashtag(h) {
  await pool.query(
    `INSERT INTO trending_hashtags
       (tag, category, rank, score, post_count, source, region, active, last_seen, fetched_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'ZA', TRUE, NOW(), NOW())
     ON CONFLICT (tag) DO UPDATE SET
       category = COALESCE(EXCLUDED.category, trending_hashtags.category),
       rank = EXCLUDED.rank,
       score = EXCLUDED.score,
       post_count = EXCLUDED.post_count,
       source = EXCLUDED.source,
       active = TRUE,
       last_seen = NOW(),
       fetched_at = NOW()`,
    [h.tag, h.category, h.rank || null, h.score || null, h.postCount || null, h.source || 'curated']
  );
}

async function run() {
  console.log('[trending] Starting hashtag refresh');

  let added = 0;

  // 1. Refresh curated baseline
  for (let i = 0; i < CURATED.length; i++) {
    const c = CURATED[i];
    await upsertHashtag({ tag: c.tag, category: c.category, rank: 1000 + i, source: 'curated' });
    added++;
  }

  // 2. Pull TikTok trending (may fail — that's OK, we still have curated)
  const tiktokTrending = await fetchTikTokTrending();
  console.log(`[trending] TikTok returned ${tiktokTrending.length} trending tags`);
  for (const h of tiktokTrending) {
    await upsertHashtag(h);
    added++;
  }

  // 3. Mark stale hashtags (not seen in 14 days) as inactive
  const staleRes = await pool.query(
    `UPDATE trending_hashtags
     SET active = FALSE
     WHERE last_seen < NOW() - INTERVAL '14 days' AND source != 'curated'
     RETURNING tag`
  );
  console.log(`[trending] Deactivated ${staleRes.rowCount} stale tags`);

  const { rows } = await pool.query(
    `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE active) AS active FROM trending_hashtags`
  );
  console.log(`[trending] DONE. Processed ${added}. DB: ${rows[0].active} active / ${rows[0].total} total`);
  process.exit(0);
}

run().catch((e) => {
  console.error('[trending] FATAL:', e);
  process.exit(1);
});
