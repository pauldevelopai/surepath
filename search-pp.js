/**
 * Search PrivateProperty.co.za for listings
 *
 * Navigates PP's area hierarchy to find listings in a suburb.
 * PP URL structure: /for-sale/{province}/{metro}/{city}/{suburb}/{area-id}
 *
 * Used when a Property24 URL is given — we find the PP equivalent to scrape
 * (PP doesn't block like P24 does).
 */

const https = require('https');

function fetchHTML(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      timeout: 15000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location.startsWith('http') ? res.headers.location : `https://www.privateproperty.co.za${res.headers.location}`;
        return fetchHTML(loc).then(resolve).catch(reject);
      }
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
        resolve(body);
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Extract area links from a PP page.
 * Returns [{ slug, id, path }] for sub-area navigation links.
 *
 * PP child paths use slugs, not parent IDs:
 *   /for-sale/western-cape/4 → children at /for-sale/western-cape/cape-town/55
 */
function extractAreaLinks(html, parentPath) {
  const links = [];
  const seen = new Set();
  // Strip trailing numeric ID from parent to get the slug-based prefix
  // e.g. /for-sale/western-cape/4 → /for-sale/western-cape
  const slugBase = parentPath.replace(/\/\d+$/, '');
  // Match: href="/for-sale/.../{slug}/{id}" where id is numeric, one level deeper than slugBase
  const re = new RegExp(`href="(${slugBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/([^/"]+)/(\\d+))"`, 'g');
  let m;
  while ((m = re.exec(html))) {
    const key = m[2] + '/' + m[3];
    if (!seen.has(key)) {
      seen.add(key);
      links.push({ slug: m[2], id: m[3], path: m[1] });
    }
  }
  return links;
}

/**
 * Extract listing links from a PP area page.
 * Returns [{ url, title, ppId }]
 */
function extractListingLinks(html, areaPath) {
  const listings = [];
  const seen = new Set();
  // Match listing URLs ending in /T{digits}
  const re = /href="(\/for-sale\/[^"]*\/(T\d+))"/g;
  let m;
  while ((m = re.exec(html))) {
    if (!seen.has(m[2])) {
      seen.add(m[2]);
      listings.push({
        url: `https://www.privateproperty.co.za${m[1]}`,
        ppId: m[2],
        path: m[1],
      });
    }
  }
  return listings;
}

/**
 * Extract basic listing info from search results HTML (price, beds, baths, address).
 */
function extractListingInfo(html) {
  const listings = [];
  // PP listings show price, beds, baths in the search results
  // We'll extract per-listing blocks
  const listingBlocks = html.split(/href="(\/for-sale\/[^"]*\/T\d+)"/g);

  for (let i = 1; i < listingBlocks.length; i += 2) {
    const url = listingBlocks[i];
    const block = listingBlocks[i + 1]?.substring(0, 1000) || '';
    const ppId = url.match(/\/(T\d+)$/)?.[1];
    if (!ppId) continue;

    // Extract price
    const priceMatch = block.match(/R\s*([\d\s]+\d{3})/);
    const price = priceMatch ? parseInt(priceMatch[1].replace(/\s/g, '')) : null;

    // Extract beds/baths from common patterns
    const bedsMatch = block.match(/(\d+)\s*(?:Bed|bed)/);
    const bathsMatch = block.match(/(\d+)\s*(?:Bath|bath)/);

    // Extract address from URL path
    const pathParts = url.split('/').filter(p => p.length > 0);
    const addressParts = pathParts.slice(5, -1).map(p => p.replace(/-/g, ' ')); // after suburb, before T-id

    listings.push({
      url: `https://www.privateproperty.co.za${url}`,
      ppId,
      price,
      beds: bedsMatch ? parseInt(bedsMatch[1]) : null,
      baths: bathsMatch ? parseInt(bathsMatch[1]) : null,
      addressHint: addressParts.join(', '),
    });
  }

  return listings;
}

/**
 * Find the best matching slug from a list of area links.
 */
function findBestMatch(areaLinks, searchTerm) {
  const slug = searchTerm.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  // Exact match
  const exact = areaLinks.find(a => a.slug === slug);
  if (exact) return exact;

  // Partial match (slug contains or is contained by search term)
  const partial = areaLinks.find(a => a.slug.includes(slug) || slug.includes(a.slug));
  if (partial) return partial;

  // Fuzzy: try without common suffixes
  const cleaned = slug.replace(/-(central|north|south|east|west|park|heights|estate|village)$/, '');
  if (cleaned !== slug) {
    const fuzzy = areaLinks.find(a => a.slug.includes(cleaned) || cleaned.includes(a.slug));
    if (fuzzy) return fuzzy;
  }

  return null;
}

/**
 * Search PP for listings in a given area.
 *
 * @param {string} province - e.g. "western-cape"
 * @param {string} city - e.g. "somerset-west" (from P24 URL)
 * @param {string} suburb - e.g. "heritage-park" (from P24 URL)
 * @param {Function} log - callback for progress logging
 * @returns {{ listings, suburbUrl, log }} or null
 */
async function searchPP(province, city, suburb, log) {
  if (!log) log = () => {};
  const ppBase = 'https://www.privateproperty.co.za';

  // Step 1: Get province page
  log(`Searching PP for ${suburb}, ${city}, ${province}...`);

  // First, find the province
  let html;
  try {
    html = await fetchHTML(`${ppBase}/for-sale/south-africa/1`);
  } catch (e) {
    log(`Failed to fetch PP homepage: ${e.message}`);
    return null;
  }

  const provinceLinks = extractAreaLinks(html, '/for-sale');
  const provinceMatch = findBestMatch(provinceLinks, province);
  if (!provinceMatch) {
    log(`Province "${province}" not found on PP. Available: ${provinceLinks.map(l => l.slug).join(', ')}`);
    return null;
  }
  log(`Found province: ${provinceMatch.slug} (${provinceMatch.path})`);

  // Step 2: Find the city — it might be 1 or 2 levels deep (metro → city)
  html = await fetchHTML(`${ppBase}${provinceMatch.path}`);
  let metroLinks = extractAreaLinks(html, provinceMatch.path);

  // Try direct match to city at this level
  let cityMatch = findBestMatch(metroLinks, city);

  if (!cityMatch) {
    // City not at metro level — search each metro for the city
    log(`City "${city}" not at metro level, searching ${metroLinks.length} metros...`);
    for (const metro of metroLinks) {
      try {
        const metroHtml = await fetchHTML(`${ppBase}${metro.path}`);
        const cityLinks = extractAreaLinks(metroHtml, metro.path);
        cityMatch = findBestMatch(cityLinks, city);
        if (cityMatch) {
          log(`Found city under ${metro.slug}: ${cityMatch.slug} (${cityMatch.path})`);
          break;
        }
      } catch {}
    }
  } else {
    log(`Found city: ${cityMatch.slug} (${cityMatch.path})`);
  }

  if (!cityMatch) {
    log(`City "${city}" not found on PP under ${provinceMatch.slug}`);
    return null;
  }

  // Step 3: Find the suburb under the city
  html = await fetchHTML(`${ppBase}${cityMatch.path}`);
  const suburbLinks = extractAreaLinks(html, cityMatch.path);
  let suburbMatch = findBestMatch(suburbLinks, suburb);

  if (!suburbMatch) {
    // Try with common variations
    const variations = [
      suburb,
      suburb.replace(/-park$/, ''),
      suburb.replace(/-central$/, ''),
      suburb.replace(/-estate$/, ''),
    ];
    for (const v of variations) {
      suburbMatch = findBestMatch(suburbLinks, v);
      if (suburbMatch) break;
    }
  }

  if (!suburbMatch) {
    log(`Suburb "${suburb}" not found on PP under ${cityMatch.slug}. Available: ${suburbLinks.slice(0, 15).map(l => l.slug).join(', ')}${suburbLinks.length > 15 ? '...' : ''}`);
    // Return the city-level listings instead
    const listings = extractListingLinks(html, cityMatch.path);
    log(`Returning ${listings.length} city-level listings from ${cityMatch.slug}`);
    return { listings, suburbUrl: `${ppBase}${cityMatch.path}`, level: 'city' };
  }

  log(`Found suburb: ${suburbMatch.slug} (${suburbMatch.path})`);

  // Step 4: Get listings in the suburb
  html = await fetchHTML(`${ppBase}${suburbMatch.path}`);
  const listings = extractListingLinks(html, suburbMatch.path);
  log(`Found ${listings.length} listings in ${suburbMatch.slug}`);

  return { listings, suburbUrl: `${ppBase}${suburbMatch.path}`, level: 'suburb' };
}

/**
 * Try to match a P24 listing to a PP listing.
 *
 * @param {Array} ppListings - listings from searchPP
 * @param {object} p24Info - { beds, baths, price, street } from P24
 * @param {Function} log
 * @returns {string|null} PP listing URL
 */
function matchListing(ppListings, p24Info, log) {
  if (!ppListings?.length) return null;
  if (!log) log = () => {};

  // If we have a street address, try to match by street name in URL
  if (p24Info.street) {
    const streetSlug = p24Info.street.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const streetMatch = ppListings.find(l => l.path.includes(streetSlug));
    if (streetMatch) {
      log(`Matched by street address: ${streetMatch.ppId}`);
      return streetMatch.url;
    }
  }

  // Without specific matching criteria, return all listings for the user to browse
  // but if there's only one listing, that's likely it
  if (ppListings.length === 1) {
    log(`Only one listing in area: ${ppListings[0].ppId}`);
    return ppListings[0].url;
  }

  log(`${ppListings.length} listings found — returning first page for browsing`);
  return null;
}

module.exports = { searchPP, matchListing, fetchHTML, extractAreaLinks, extractListingLinks };
