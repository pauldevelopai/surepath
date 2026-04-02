import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { withAuth } from "@/lib/auth";
import path from "path";

async function loadModule(name: string) {
  const modPath = path.resolve(process.cwd(), "..", `${name}.js`);
  const mod = await import(/* webpackIgnore: true */ modPath);
  return mod.default || mod;
}

function titleCase(s: string) {
  return s.replace(/-/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
}

export const POST = withAuth(async (req: NextRequest) => {
  const { address } = await req.json();
  if (!address || address.length < 5) return NextResponse.json({ error: "Address too short" }, { status: 400 });

  const input = address.trim();
  const isP24 = input.includes("property24.com");
  const isPP = input.includes("privateproperty.co.za");
  const log: string[] = [];

  // Clean URL: strip query strings, fragments, trailing slashes
  const cleanUrl = input.replace(/[?#].*$/, "").replace(/\/+$/, "");

  // Extract listing ID
  let erfNumber: string | null = null;
  if (isP24) {
    const match = cleanUrl.match(/\/(\d{6,})$/);
    erfNumber = match ? `P24_${match[1]}` : null;
    if (erfNumber) log.push(`Parsed P24 listing ID: ${match![1]}`);
    else log.push("Could not extract P24 listing ID from URL");
  } else if (isPP) {
    const match = cleanUrl.match(/(T\d+)$/);
    erfNumber = match ? `PP_${match[1]}` : null;
    if (erfNumber) log.push(`Parsed PP listing ID: ${match![1]}`);
  }

  // ── Check for existing property ──

  // By erf_number
  if (erfNumber) {
    const existing = await query("SELECT id FROM properties WHERE erf_number = $1", [erfNumber]);
    if (existing.length > 0) {
      log.push(`Found existing property by listing ID`);
      return NextResponse.json({ id: existing[0].id, created: false, log });
    }
  }

  // By listing URL
  if (isP24 || isPP) {
    const existing = await query(
      "SELECT id FROM properties WHERE listing_url ILIKE $1 OR listing_url ILIKE $2",
      [`%${cleanUrl}%`, `%${cleanUrl}/%`]
    );
    if (existing.length > 0) {
      log.push(`Found existing property by listing URL`);
      return NextResponse.json({ id: existing[0].id, created: false, log });
    }

    // For PP URLs with a full street-level path, try matching by street name
    // Only match when URL has enough segments (7+) to include a real street address
    // Avoids false matches on suburb names like "observatory" or "heritage-park"
    if (isPP) {
      const ppPathParts = cleanUrl.replace(/.*\/for-sale\//, "").split("/");
      if (ppPathParts.length >= 7) {
        const streetPart = ppPathParts.slice(-3, -1).join(" ").replace(/-/g, " ");
        if (streetPart.length > 8) {
          const existing = await query(
            "SELECT id FROM properties WHERE street_address ILIKE $1",
            [`%${streetPart}%`]
          );
          if (existing.length > 0) {
            log.push(`Found existing property by street address: "${streetPart}"`);
            return NextResponse.json({ id: existing[0].id, created: false, log });
          }
        }
      }
    }
  } else {
    // Plain address search
    const existing = await query(
      "SELECT id FROM properties WHERE address_raw ILIKE $1 OR address_normalised ILIKE $1 OR street_address ILIKE $1",
      [`%${input}%`]
    );
    if (existing.length > 0) {
      log.push(`Found existing property by address`);
      return NextResponse.json({ id: existing[0].id, created: false, log });
    }
  }

  // ── P24 URL: find PP equivalent and scrape that ──
  if (isP24) {
    // Extract suburb/city/province from P24 URL: /for-sale/{suburb}/{city}/{province}/{code}/{id}
    const p24Parts = cleanUrl.match(/\/for-sale\/([^/]+)\/([^/]+)\/([^/]+)\/\d+\/\d+/);
    const p24SuburbSlug = p24Parts?.[1] || null;
    const p24CitySlug = p24Parts?.[2] || null;
    const p24ProvinceSlug = p24Parts?.[3] || null;
    const p24Suburb = p24SuburbSlug ? titleCase(p24SuburbSlug) : null;
    const p24City = p24CitySlug ? titleCase(p24CitySlug) : null;
    const p24Province = p24ProvinceSlug ? titleCase(p24ProvinceSlug) : null;

    log.push(`P24 location: ${p24Suburb}, ${p24City}, ${p24Province}`);

    // Note: we don't match by suburb here — a P24 URL is for a SPECIFIC listing,
    // not any property in that suburb. The erf_number and listing_url checks above
    // already handle exact matches.

    // Search PrivateProperty for this suburb
    let ppListingUrl: string | null = null;
    let ppListings: { url: string; ppId: string }[] = [];

    if (p24SuburbSlug && p24CitySlug && p24ProvinceSlug) {
      try {
        const searchPP = await loadModule("search-pp");
        log.push(`Searching PrivateProperty.co.za for ${p24Suburb}...`);
        const ppResult = await searchPP.searchPP(
          p24ProvinceSlug, p24CitySlug, p24SuburbSlug,
          (msg: string) => log.push(msg)
        );

        if (ppResult?.listings?.length) {
          ppListings = ppResult.listings;
          log.push(`Found ${ppListings.length} PP listings in ${p24Suburb}`);

          // Try to match by street address from P24 URL (rare but sometimes in URL)
          // For now, take the first listing — user can always rescrape specific ones
          ppListingUrl = ppListings[0].url;
          log.push(`Selected PP listing: ${ppListings[0].ppId}`);
        } else {
          log.push(`No PP listings found for ${p24Suburb}`);
        }
      } catch (err) {
        log.push(`PP search failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // If we found a PP listing, scrape it
    if (ppListingUrl) {
      const ppId = ppListingUrl.match(/(T\d+)$/)?.[1];
      if (ppId) {
        const ppErfNumber = `PP_${ppId}`;

        // Check if this PP listing already exists
        const existingPP = await query("SELECT id FROM properties WHERE erf_number = $1", [ppErfNumber]);
        if (existingPP.length > 0) {
          log.push(`PP listing ${ppId} already on file`);
          // Link the P24 URL to the existing property
          await query("UPDATE properties SET data_sources = COALESCE(data_sources, '{}'::jsonb) || $1::jsonb WHERE id = $2",
            [JSON.stringify({ p24_url: { name: "Property24 URL", url: input, confidence: "unverified", date: new Date().toISOString() } }), existingPP[0].id]);
          return NextResponse.json({ id: existingPP[0].id, created: false, log });
        }

        log.push(`Scraping PP listing ${ppId}...`);
        try {
          return await scrapePPListing(ppListingUrl, ppErfNumber, input, log);
        } catch (err) {
          log.push(`PP scrape failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // If we have multiple PP listings, store them as references and scrape the first viable one
    if (ppListings.length > 1 && !ppListingUrl) {
      log.push(`Multiple PP listings available — storing references`);
    }

    // Fallback: create basic property from P24 URL info
    log.push(`Creating property from P24 URL info (no PP listing scraped)`);
    const provenance = await loadModule("provenance");
    const result = await query(
      "INSERT INTO properties (erf_number, address_raw, suburb, city, province, listing_url) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (erf_number) DO NOTHING RETURNING id",
      [erfNumber || `P24_${Date.now()}`, `Property in ${p24Suburb || "unknown"}`, p24Suburb, p24City, p24Province, input]
    );

    let propertyId: number;
    if (result.length > 0) {
      propertyId = result[0].id;
      await provenance.recordSource(propertyId, "Property24 URL", input, "unverified", ["address_raw", "suburb", "city", "province", "listing_url"]);
    } else {
      const ex = await query("SELECT id FROM properties WHERE erf_number = $1", [erfNumber]);
      propertyId = ex[0]?.id;
    }

    // Store PP listing references if we found any
    if (ppListings.length > 0) {
      await query("UPDATE properties SET data_sources = COALESCE(data_sources, '{}'::jsonb) || $1::jsonb WHERE id = $2",
        [JSON.stringify({ pp_listings: { listings: ppListings.slice(0, 10).map(l => ({ url: l.url, ppId: l.ppId })), note: "PP listings in same suburb — rescrape to load" } }), propertyId]);
    }

    // Geocode
    if (process.env.GOOGLE_MAPS_API_KEY && p24Suburb) {
      try {
        const maps = await loadModule("maps");
        const geo = await maps.geocode(`${p24Suburb}, ${p24City}, South Africa`);
        if (geo) {
          await query("UPDATE properties SET lat=$1, lng=$2, address_normalised=$3 WHERE id=$4", [geo.lat, geo.lng, geo.formatted_address, propertyId]);
          await provenance.recordSource(propertyId, "Google Maps Geocoding API", `https://www.google.com/maps/@${geo.lat},${geo.lng},18z`, "verified", ["lat", "lng", "address_normalised"]);
          log.push(`Geocoded: ${geo.formatted_address}`);
        }
      } catch {}
    }

    return NextResponse.json({ id: propertyId, created: true, scraped: false, log });
  }

  // ── PP URL: scrape directly ──
  if (isPP && erfNumber) {
    log.push(`Scraping PrivateProperty listing...`);
    try {
      return await scrapePPListing(cleanUrl, erfNumber, null, log);
    } catch (err) {
      // Scraping failed — fall back to creating basic property
      log.push(`Scrape failed: ${err instanceof Error ? err.message : String(err)}`);
      const fallbackResult = await query(
        "INSERT INTO properties (erf_number, address_raw, listing_url) VALUES ($1, $2, $3) ON CONFLICT (erf_number) DO NOTHING RETURNING id",
        [erfNumber, input, input]
      );
      if (fallbackResult.length > 0) {
        const provenance = await loadModule("provenance");
        await provenance.recordSource(fallbackResult[0].id, "PrivateProperty URL", input, "scraped", ["address_raw", "listing_url"]);
        return NextResponse.json({ id: fallbackResult[0].id, created: true, scraped: false, log });
      }
      const ex = await query("SELECT id FROM properties WHERE erf_number = $1", [erfNumber]);
      return NextResponse.json({ id: ex[0]?.id, created: false, log });
    }
  }

  // ── Street address lookup ──
  log.push(`Looking up address: ${input}`);
  const lookupErfNumber = `LOOKUP_${Date.now()}`;
  const result = await query(
    "INSERT INTO properties (erf_number, address_raw) VALUES ($1, $2) RETURNING id",
    [lookupErfNumber, input]
  );
  const propertyId = result[0].id;

  const provenance = await loadModule("provenance");
  await provenance.recordSource(propertyId, "Manual address lookup", null, "unverified", ["address_raw"]);

  if (process.env.GOOGLE_MAPS_API_KEY) {
    try {
      const maps = await loadModule("maps");
      const geo = await maps.geocode(input + ", South Africa");
      if (geo) {
        await query(
          `UPDATE properties SET lat=$1, lng=$2, address_normalised=$3, suburb=COALESCE($4,suburb), city=COALESCE($5,city), province=COALESCE($6,province) WHERE id=$7`,
          [geo.lat, geo.lng, geo.formatted_address, geo.suburb, geo.city, geo.province, propertyId]
        );
        await provenance.recordSource(propertyId, "Google Maps Geocoding API",
          `https://www.google.com/maps/@${geo.lat},${geo.lng},18z`, "verified",
          ["lat", "lng", "address_normalised", "suburb", "city", "province"]);
        log.push(`Geocoded: ${geo.formatted_address}`);
      }
    } catch {}
  }

  return NextResponse.json({ id: propertyId, created: true, log });
});


/**
 * Scrape a PrivateProperty listing page and store all data.
 */
async function scrapePPListing(ppUrl: string, erfNumber: string, p24Url: string | null, log: string[]) {
  const puppeteer = await import("puppeteer");
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36");
  await page.goto(ppUrl, { waitUntil: "networkidle0", timeout: 30000 });
  await new Promise(r => setTimeout(r, 2000));

  const listing = await page.evaluate(() => {
    const r: Record<string, unknown> = { photos: [] as string[] };
    const body = document.body.innerText;

    // Title
    r.title = document.querySelector("h1")?.textContent?.trim() || null;

    // JSON-LD
    document.querySelectorAll('script[type="application/ld+json"]').forEach(el => {
      try {
        const parsed = JSON.parse(el.innerHTML);
        const items = (parsed as { "@graph"?: unknown[] })["@graph"] || [parsed];
        for (const item of items as Record<string, unknown>[]) {
          if ((item as { "@type"?: string })["@type"] === "RealEstateListing") {
            const about = (item as { about?: Record<string, unknown> }).about || {};
            const offers = (item as { offers?: Record<string, unknown> }).offers || {};
            const price = (offers as { priceSpecification?: Record<string, unknown> }).priceSpecification || {};
            const agent = (offers as { offeredBy?: Record<string, unknown> }).offeredBy || {};
            const agency = (agent as { worksFor?: Record<string, unknown> }).worksFor || {};
            const addr = (about as { address?: Record<string, unknown> }).address || {};

            if ((item as { name?: string }).name) r.title = (item as { name: string }).name;
            if ((item as { datePosted?: string }).datePosted) r.date_posted = (item as { datePosted: string }).datePosted;
            r.bedrooms = (about as { numberOfBedrooms?: number }).numberOfBedrooms || null;
            r.bathrooms = (about as { numberOfBathroomsTotal?: number }).numberOfBathroomsTotal || null;
            r.floor_size = ((about as { floorSize?: { value?: number } }).floorSize || {}).value || null;
            r.pets_allowed = (about as { petsAllowed?: boolean }).petsAllowed || null;
            r.p24_lat = (about as { latitude?: number }).latitude || null;
            r.p24_lng = (about as { longitude?: number }).longitude || null;
            r.street_address = (addr as { streetAddress?: string }).streetAddress || null;
            r.suburb_jsonld = (addr as { addressLocality?: string }).addressLocality || null;
            r.region_jsonld = (addr as { addressRegion?: string }).addressRegion || null;
            r.price = (price as { price?: string }).price ? parseInt((price as { price: string }).price) : null;
            r.agent_name = (agent as { name?: string }).name || null;
            r.agent_url = (agent as { url?: string }).url || null;
            r.agency_name = (agency as { name?: string }).name || null;
            r.agency_url = (agency as { url?: string }).url || null;
          }
        }
      } catch {}
    });

    // Text extraction fallback
    const extract = (label: string) => {
      const m = body.match(new RegExp(label + "[:\\s]*([^\\n]+)", "i"));
      return m ? m[1].trim() : null;
    };

    if (!r.price) {
      const priceMatch = body.match(/R\s*([\d\s]+\d{3})/);
      r.price = priceMatch ? parseInt((priceMatch[1] as string).replace(/\s/g, "")) : null;
    }
    if (!r.bedrooms) { const m = body.match(/(\d+)\s*Bed/i); r.bedrooms = m ? parseInt(m[1]) : null; }
    if (!r.bathrooms) { const m = body.match(/(\d+)\s*Bath/i); r.bathrooms = m ? parseInt(m[1]) : null; }
    if (!r.floor_size) { const m = body.match(/(\d+)\s*m²/); r.floor_size = m ? parseInt(m[1]) : null; }

    const leviesText = extract("Levies");
    r.levies = leviesText ? parseInt(leviesText.replace(/[^\d]/g, "")) || null : null;
    const ratesText = extract("Rates and Taxes") || extract("Rates");
    r.rates = ratesText ? parseInt(ratesText.replace(/[^\d]/g, "")) || null : null;

    const parkMatch = body.match(/Parking:\s*(\d+)/);
    r.parking = parkMatch ? parseInt(parkMatch[1]) : null;

    r.pet_friendly = /pet[s]?\s*(?:allowed|friendly)/i.test(body);
    r.furnished = /\bfurnished\b/i.test(body);

    // Property type
    const typeText = body.toLowerCase();
    if (typeText.includes("apartment") || typeText.includes("flat")) r.property_type = "sectional";
    else if (typeText.includes("house") && !typeText.includes("townhouse")) r.property_type = "freehold";
    else if (typeText.includes("townhouse") || typeText.includes("cluster")) r.property_type = "estate";

    // Description
    const descEl = document.querySelector('[class*="description"], [class*="listing-body"]');
    r.description = descEl ? descEl.textContent?.trim()?.substring(0, 3000) : null;

    // Agent (fallback)
    if (!r.agent_name) {
      const agentEl = document.querySelector('[class*="agent-name"], [class*="consultant"]');
      r.agent_name = agentEl ? agentEl.textContent?.trim() : null;
    }
    if (!r.agency_name) {
      const agencyEl = document.querySelector('[class*="agency-name"], [class*="brand-name"]');
      r.agency_name = agencyEl ? agencyEl.textContent?.trim() : null;
    }

    // ALL photos
    const photos = r.photos as string[];
    const seen = new Set<string>();
    document.querySelectorAll("img[src], img[data-src]").forEach(el => {
      const src = (el as HTMLImageElement).src || (el as HTMLElement).dataset?.src || "";
      if (src.length > 40 && !src.includes("logo") && !src.includes("icon") && !src.includes("NoImage") && !src.includes("avatar")) {
        const ppMatch = src.match(/images\.pp\.co\.za\/listing\/(\d+)\/([A-Za-z0-9_-]+)/);
        if (ppMatch && !seen.has(ppMatch[2])) {
          seen.add(ppMatch[2]);
          photos.push(`https://images.pp.co.za/listing/${ppMatch[1]}/${ppMatch[2]}/1600/1066/contain/jpegorpng`);
        }
        const p24Match = src.match(/images\.prop24\.com\/(\d+)/);
        if (p24Match && !seen.has(p24Match[1])) {
          seen.add(p24Match[1]);
          photos.push(`https://images.prop24.com/${p24Match[1]}/Ensure960x540`);
        }
      }
    });
    // Scan HTML for image URLs
    const html = document.documentElement.innerHTML;
    const ppMatches = html.matchAll(/images\.pp\.co\.za\/listing\/(\d+)\/([A-Za-z0-9_-]+)/g);
    for (const m of ppMatches) {
      if (!seen.has(m[2])) { seen.add(m[2]); photos.push(`https://images.pp.co.za/listing/${m[1]}/${m[2]}/1600/1066/contain/jpegorpng`); }
    }
    const p24Matches = html.matchAll(/images\.prop24\.com\/(\d+)\/([A-Za-z0-9]+)/g);
    for (const m of p24Matches) {
      if (!seen.has(m[1])) { seen.add(m[1]); photos.push(`https://images.prop24.com/${m[1]}/${m[2]}`); }
    }

    return r;
  });

  await browser.close();

  // Derive suburb/city from PP URL path
  const urlParts = ppUrl.match(/\/for-sale\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)/);
  const province = (listing.region_jsonld as string) || (urlParts ? titleCase(urlParts[1]) : null);
  const city = urlParts ? titleCase(urlParts[2]) : null;
  const suburb = (listing.suburb_jsonld as string) || (urlParts ? titleCase(urlParts[4]) : null);

  const streetAddr = listing.street_address && (listing.street_address as string).length > 3 ? listing.street_address as string : null;
  const title = streetAddr ? `${streetAddr}, ${suburb}` : (listing.title as string) || `Property in ${suburb}`;

  log.push(`Scraped: ${title}`);
  if (listing.price) log.push(`Price: R${Number(listing.price).toLocaleString()}`);
  if (listing.bedrooms) log.push(`${listing.bedrooms} bed, ${listing.bathrooms || "?"} bath`);

  // Insert property
  const listingUrl = p24Url || ppUrl; // Store P24 URL if that's what the user entered, PP URL otherwise
  const result = await query(
    `INSERT INTO properties (
      erf_number, address_raw, street_address, suburb, city, province,
      property_type, floor_area_sqm, bedrooms, bathrooms,
      listing_number, listing_url, listing_date, asking_price,
      levies, rates_and_taxes, parking_spaces,
      pet_friendly, furnished, description,
      agent_name, agent_url, agency_name, agency_url,
      listing_image_url, p24_lat, p24_lng, last_scraped_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,NOW())
    ON CONFLICT (erf_number) DO NOTHING RETURNING id`,
    [
      erfNumber, title, streetAddr, suburb, city, province,
      listing.property_type, listing.floor_size, listing.bedrooms, listing.bathrooms,
      erfNumber?.replace(/^(P24_|PP_)/, ""), listingUrl, listing.date_posted || null, listing.price,
      listing.levies, listing.rates, listing.parking,
      listing.pet_friendly || null, listing.furnished || null, listing.description,
      listing.agent_name, listing.agent_url, listing.agency_name, listing.agency_url,
      (listing.photos as string[])[0] || null, listing.p24_lat, listing.p24_lng,
    ]
  );

  if (!result.length) {
    const ex = await query("SELECT id FROM properties WHERE erf_number = $1", [erfNumber]);
    log.push(`Property already existed`);
    return NextResponse.json({ id: ex[0].id, created: false, log });
  }

  const propertyId = result[0].id;

  // Store all photos
  let photoCount = 0;
  const photosSeen = new Set<string>();
  for (const url of (listing.photos as string[])) {
    const imgId = url.match(/\/([A-Za-z0-9_-]+)\/\d+\/\d+\//)?.[1] || url.match(/prop24\.com\/(\d+)/)?.[1];
    if (imgId && photosSeen.has(imgId)) continue;
    if (imgId) photosSeen.add(imgId);
    await query("INSERT INTO property_images (property_id, source, image_url, image_type) VALUES ($1, $2, $3, 'listing')", [propertyId, "privateproperty", url]);
    photoCount++;
  }
  log.push(`Saved ${photoCount} photos`);

  // Store P24 URL as additional reference if we came from P24
  if (p24Url) {
    await query("UPDATE properties SET data_sources = COALESCE(data_sources, '{}'::jsonb) || $1::jsonb WHERE id = $2",
      [JSON.stringify({ p24_url: { name: "Property24 URL", url: p24Url, confidence: "unverified", date: new Date().toISOString() } }), propertyId]);
    // Also store the PP URL since listing_url has the P24 URL
    await query("UPDATE properties SET data_sources = COALESCE(data_sources, '{}'::jsonb) || $1::jsonb WHERE id = $2",
      [JSON.stringify({ pp_url: { name: "PrivateProperty Listing", url: ppUrl, confidence: "scraped", date: new Date().toISOString() } }), propertyId]);
  }

  // Record provenance
  const provenance = await loadModule("provenance");
  const fields = ["address_raw", "erf_number", "listing_url", "suburb", "city", "province"];
  if (streetAddr) fields.push("street_address");
  if (listing.bedrooms) fields.push("bedrooms");
  if (listing.bathrooms) fields.push("bathrooms");
  if (listing.floor_size) fields.push("floor_area_sqm");
  if (listing.property_type) fields.push("property_type");
  if (listing.price) fields.push("asking_price");
  if (listing.levies) fields.push("levies");
  if (listing.rates) fields.push("rates_and_taxes");
  if (listing.parking) fields.push("parking_spaces");
  if (listing.description) fields.push("description");
  if (listing.agent_name) fields.push("agent_name");
  if (listing.agency_name) fields.push("agency_name");

  await provenance.recordSource(propertyId, "PrivateProperty Listing", ppUrl, "scraped", fields);

  // Geocode
  if (process.env.GOOGLE_MAPS_API_KEY) {
    try {
      const maps = await loadModule("maps");
      const searchAddr = streetAddr ? `${streetAddr}, ${suburb}, ${city}, South Africa` : `${suburb}, ${city}, South Africa`;
      const geo = await maps.geocode(searchAddr);
      if (geo) {
        await query(
          `UPDATE properties SET lat=$1, lng=$2, address_normalised=$3, suburb=COALESCE($4,suburb), city=COALESCE($5,city), province=COALESCE($6,province) WHERE id=$7`,
          [geo.lat, geo.lng, geo.formatted_address, geo.suburb, geo.city, geo.province, propertyId]
        );
        await provenance.recordSource(propertyId, "Google Maps Geocoding API",
          `https://www.google.com/maps/@${geo.lat},${geo.lng},18z`, "verified",
          ["lat", "lng", "address_normalised", "suburb", "city", "province"]);
        log.push(`Geocoded: ${geo.formatted_address}`);
      }
    } catch {}
  }

  return NextResponse.json({ id: propertyId, created: true, scraped: true, photos: photoCount, log });
}
