/**
 * Match a Property24 listing to its PrivateProperty equivalent
 * using Google Vision API reverse image search.
 *
 * Strategy:
 * 1. Scrape P24 listing with Puppeteer to get photo URLs
 * 2. Send 3-5 photos to Google Vision API WEB_DETECTION
 * 3. Look for privateproperty.co.za URLs in the matching pages
 * 4. Extract the PP listing URL (T-number)
 * 5. Return the PP URL if found
 */

const https = require('https');
const pool = require('./db');

const GOOGLE_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

/**
 * Reverse image search a single photo URL via Google Vision API.
 * Returns array of matching page URLs.
 */
function reverseImageSearch(imageUrl) {
  return new Promise((resolve, reject) => {
    const url = `https://vision.googleapis.com/v1/images:annotate?key=${GOOGLE_API_KEY}`;
    const body = JSON.stringify({
      requests: [{
        image: { source: { imageUri: imageUrl } },
        features: [{ type: 'WEB_DETECTION', maxResults: 10 }],
      }],
    });

    const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(data);
          if (r.error) { console.error(`[vision] API error: ${r.error.message}`); resolve([]); return; }
          const web = r.responses?.[0]?.webDetection;
          const pages = (web?.pagesWithMatchingImages || []).map(p => p.url);
          resolve(pages);
        } catch (e) {
          resolve([]);
        }
      });
    });
    req.on('error', () => resolve([]));
    req.write(body);
    req.end();
  });
}

/**
 * Extract P24 listing photo URLs using Puppeteer.
 */
async function getP24Photos(p24Url) {
  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
  await page.goto(p24Url, { waitUntil: 'networkidle0', timeout: 20000 });
  await page.evaluate(() => window.scrollBy(0, 500));
  await new Promise(r => setTimeout(r, 2000));

  const photos = await page.evaluate(() => {
    const found = [];
    const seen = new Set();
    const html = document.documentElement.innerHTML;
    // Find unique prop24 image IDs
    const matches = html.match(/images\.prop24\.com\/(\d+)/g) || [];
    for (const m of matches) {
      const id = m.match(/(\d+)$/)?.[1];
      if (id && !seen.has(id) && parseInt(id) > 300000000) { // listing photos have high IDs
        seen.add(id);
        found.push(`https://images.prop24.com/${id}/Ensure1280x720`);
      }
    }
    return found;
  });

  await browser.close();
  return photos;
}

/**
 * Match a P24 listing URL to its PP equivalent via reverse image search.
 *
 * @param {string} p24Url - Property24 listing URL
 * @returns {{ ppUrl: string|null, ppId: string|null, confidence: string, photosChecked: number }}
 */
async function matchP24toPP(p24Url) {
  console.log(`[p24→pp] Matching ${p24Url}`);

  if (!GOOGLE_API_KEY) {
    console.log('[p24→pp] No Google API key — skipping');
    return { ppUrl: null, ppId: null, confidence: 'no_api_key', photosChecked: 0 };
  }

  // Step 1: Get P24 photos
  let photos;
  try {
    photos = await getP24Photos(p24Url);
    console.log(`[p24→pp] Found ${photos.length} P24 photos`);
  } catch (err) {
    console.error(`[p24→pp] Failed to get P24 photos: ${err.message}`);
    return { ppUrl: null, ppId: null, confidence: 'scrape_failed', photosChecked: 0 };
  }

  if (photos.length === 0) {
    return { ppUrl: null, ppId: null, confidence: 'no_photos', photosChecked: 0 };
  }

  // Step 2: Try up to 5 photos through Google Vision
  // Skip the first photo (often a hero/lifestyle shot) and use property-specific ones
  const photosToCheck = photos.slice(1, 6);
  if (photosToCheck.length === 0) photosToCheck.push(photos[0]);

  const ppUrlCounts = {}; // count how many photos match each PP URL
  let checked = 0;

  for (const photo of photosToCheck) {
    checked++;
    console.log(`[p24→pp] Checking photo ${checked}/${photosToCheck.length}: ...${photo.slice(-20)}`);

    const matchingPages = await reverseImageSearch(photo);
    const ppPages = matchingPages.filter(u => u.includes('privateproperty.co.za/for-sale/'));

    for (const ppPage of ppPages) {
      // Extract the PP listing URL with T-number
      const tMatch = ppPage.match(/(\/for-sale\/[^?#]+\/T\d+)/);
      if (tMatch) {
        const ppListingPath = tMatch[1];
        ppUrlCounts[ppListingPath] = (ppUrlCounts[ppListingPath] || 0) + 1;
      }
    }

    // If we already have a strong match (2+ photos), stop early
    const bestCount = Math.max(0, ...Object.values(ppUrlCounts));
    if (bestCount >= 2) {
      console.log(`[p24→pp] Strong match found after ${checked} photos`);
      break;
    }
  }

  // Step 3: Find the best match
  let bestUrl = null;
  let bestCount = 0;
  for (const [path, count] of Object.entries(ppUrlCounts)) {
    if (count > bestCount) {
      bestUrl = 'https://www.privateproperty.co.za' + path;
      bestCount = count;
    }
  }

  if (bestUrl) {
    const ppId = bestUrl.match(/(T\d+)$/)?.[1] || null;
    const confidence = bestCount >= 3 ? 'high' : bestCount >= 2 ? 'medium' : 'low';
    console.log(`[p24→pp] Match: ${bestUrl} (${bestCount} photos matched, confidence: ${confidence})`);

    // Log the cost
    try {
      const { logGoogle } = require('./costs');
      if (logGoogle) await logGoogle('google_vision_web_detection', checked, null);
    } catch {}

    return { ppUrl: bestUrl, ppId, confidence, photosChecked: checked };
  }

  console.log(`[p24→pp] No PP match found after checking ${checked} photos`);
  return { ppUrl: null, ppId: null, confidence: 'no_match', photosChecked: checked };
}

module.exports = { matchP24toPP, reverseImageSearch, getP24Photos };
