/**
 * Quick test: P24 OG extraction → Vision reverse image search → PP match
 *
 * Usage: node test-og-flow.js [property24-url]
 */
require('dotenv').config();

const { fetchHTML } = require('./pipeline');
const { reverseImageSearch } = require('./match-p24-to-pp');

const TEST_URL = process.argv[2] || 'https://www.property24.com/for-sale/helderberg-estate/somerset-west/western-cape/10308/116289383';

async function test() {
  console.log(`\n=== Testing OG flow for: ${TEST_URL} ===\n`);

  // Step 1: Fetch HTML
  console.log('[1] Fetching P24 page (plain HTTP)...');
  let html;
  try {
    html = await fetchHTML(TEST_URL);
    console.log(`    Got ${html.length} bytes\n`);
  } catch (err) {
    console.error(`    FAILED: ${err.message}`);
    // P24 might block with 403 — check
    if (err.message.includes('403')) {
      console.log('    P24 returned 403 — trying with different user-agent might help');
    }
    return;
  }

  // Step 2: Extract OG tags
  console.log('[2] Extracting OG meta tags...');
  const ogImage = (html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
                   html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i) || [])[1] || null;
  const ogTitle = (html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
                   html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i) || [])[1] || null;
  const ogDesc = (html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i) ||
                  html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i) || [])[1] || null;

  console.log(`    og:image: ${ogImage || 'NOT FOUND'}`);
  console.log(`    og:title: ${ogTitle || 'NOT FOUND'}`);
  console.log(`    og:description: ${ogDesc || 'NOT FOUND'}`);

  // Parse structured data
  const titleBedsM = (ogTitle || '').match(/(\d+)\s*Bed/i);
  const bedrooms = titleBedsM ? parseInt(titleBedsM[1]) : null;
  const bathsM = (ogDesc || '').match(/(\d+)\s*Bath/i);
  const bathrooms = bathsM ? parseInt(bathsM[1]) : null;
  let price = null;
  const priceText = (ogDesc || '').match(/R\s*([\d\s,]+)/);
  if (priceText) {
    const parsed = parseInt(priceText[1].replace(/[\s,]/g, ''));
    if (parsed >= 100000) price = parsed;
  }

  console.log(`\n    Parsed: ${bedrooms || '?'} bed, ${bathrooms || '?'} bath, R${price || '?'}`);

  if (!ogImage) {
    console.log('\n    No OG image found — cannot proceed with Vision search');
    // Check if there are any meta tags at all
    const metaCount = (html.match(/<meta /gi) || []).length;
    console.log(`    (Page has ${metaCount} meta tags total)`);
    // Show first few meta tags for debugging
    const metas = html.match(/<meta[^>]+>/gi) || [];
    console.log('    First 10 meta tags:');
    metas.slice(0, 10).forEach(m => console.log(`      ${m}`));
    return;
  }

  // Step 3: Vision reverse image search
  console.log(`\n[3] Running Google Vision reverse image search on OG image...`);
  try {
    const pages = await reverseImageSearch(ogImage);
    console.log(`    Found ${pages.length} matching pages:`);
    pages.forEach((p, i) => console.log(`      ${i + 1}. ${p}`));

    const ppPages = pages.filter(u => u.includes('privateproperty.co.za'));
    if (ppPages.length > 0) {
      console.log(`\n    PP MATCHES: ${ppPages.length}`);
      ppPages.forEach(p => console.log(`      ${p}`));

      const tMatch = ppPages[0].match(/(https?:\/\/www\.privateproperty\.co\.za\/for-sale\/[^?#]+\/T\d+)/);
      if (tMatch) {
        console.log(`\n    BEST PP URL: ${tMatch[1]}`);
      }
    } else {
      console.log('\n    No PrivateProperty matches found');
    }
  } catch (err) {
    console.error(`    Vision search failed: ${err.message}`);
  }

  console.log('\n=== Done ===\n');
}

test().catch(console.error);
