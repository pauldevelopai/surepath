const https = require('https');
const pool = require('./db');

const API_KEY = process.env.GOOGLE_MAPS_API_KEY;

/**
 * Make an HTTPS GET request and return the response body.
 * For JSON endpoints, parse the response. For binary, return a Buffer.
 */
function httpGet(url, binary = false) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow redirects
        return httpGet(res.headers.location, binary).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${body}`)));
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve(binary ? buffer : JSON.parse(buffer.toString()));
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Geocode an address string using Google Maps Geocoding API.
 * Returns { lat, lng, suburb, city, province, formatted_address } or null.
 */
/**
 * Extract location context from a SA property listing URL.
 * e.g. "privateproperty.co.za/for-sale/kwazulu-natal/durban-metro/hillcrest/albany/T123"
 *   → { province: "kwazulu-natal", city: "durban-metro", area: "hillcrest", suburb: "albany" }
 */
function extractLocationFromURL(url) {
  if (!url) return null;
  // PrivateProperty: /for-sale/{province}/{city}/{area}/{suburb}/T{id}
  const ppMatch = url.match(/privateproperty\.co\.za\/for-sale\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\//i);
  if (ppMatch) {
    return {
      province: ppMatch[1].replace(/-/g, ' '),
      city: ppMatch[2].replace(/-/g, ' '),
      area: ppMatch[3].replace(/-/g, ' '),
      suburb: ppMatch[4].replace(/-/g, ' '),
    };
  }
  // Property24: /for-sale/{suburb}/{city}/{province}/{code}/{id}
  const p24Match = url.match(/property24\.com\/for-sale\/([^/]+)\/([^/]+)\/([^/]+)\/(\d+)\//i);
  if (p24Match) {
    return {
      suburb: p24Match[1].replace(/-/g, ' '),
      city: p24Match[2].replace(/-/g, ' '),
      province: p24Match[3].replace(/-/g, ' '),
    };
  }
  return null;
}

async function geocode(address, listingUrl) {
  if (!API_KEY) throw new Error('GOOGLE_MAPS_API_KEY not set');

  // Enrich the address with location context from the listing URL
  // This prevents "Albany" (SA) from geocoding to "Albany, NY, USA"
  let geocodeAddress = address;
  const urlLocation = extractLocationFromURL(listingUrl);
  if (urlLocation) {
    // Check if the address already contains meaningful location info
    const hasLocation = /south africa|cape town|johannesburg|durban|pretoria|bloemfontein/i.test(address);
    if (!hasLocation) {
      // Build a location string from the URL: "Albany, Hillcrest, Durban Metro, KwaZulu-Natal, South Africa"
      const parts = [address.replace(/^\d+\s*bedroom\s+(house|apartment|townhouse|flat|cluster|farm|land)\s+in\s+/i, '')];
      if (urlLocation.area && urlLocation.area !== urlLocation.suburb) parts.push(urlLocation.area);
      if (urlLocation.city) parts.push(urlLocation.city);
      if (urlLocation.province) parts.push(urlLocation.province);
      parts.push('South Africa');
      geocodeAddress = parts.join(', ');
      console.log(`[geocode] Enriched address: "${address}" → "${geocodeAddress}"`);
    }
  }

  const encoded = encodeURIComponent(geocodeAddress);
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encoded}&region=za&key=${API_KEY}`;

  try {
    const data = await httpGet(url);

    if (data.status !== 'OK' || !data.results.length) {
      console.error(`Geocoding failed for "${address}": ${data.status}`);
      return null;
    }

    const result = data.results[0];
    const loc = result.geometry.location;
    const components = result.address_components;

    let suburb = null, city = null, province = null;
    for (const c of components) {
      if (c.types.includes('sublocality') || c.types.includes('sublocality_level_1')) {
        suburb = c.long_name;
      }
      if (c.types.includes('locality')) {
        city = c.long_name;
      }
      if (c.types.includes('administrative_area_level_1')) {
        province = c.long_name;
      }
    }

    // Log cost
    try { const { logGoogle } = require('./costs'); await logGoogle('google_geocoding'); } catch {}

    return {
      lat: loc.lat,
      lng: loc.lng,
      suburb,
      city,
      province,
      formatted_address: result.formatted_address,
    };
  } catch (err) {
    console.error(`Geocoding error for "${address}":`, err.message);
    return null;
  }
}

/**
 * Get the actual Street View panorama location via the metadata API.
 * Returns { pano_lat, pano_lng } — where the camera actually is.
 */
async function getStreetViewMeta(lat, lng) {
  const url = `https://maps.googleapis.com/maps/api/streetview/metadata?location=${lat},${lng}&key=${API_KEY}`;
  try {
    const data = await httpGet(url);
    const meta = JSON.parse(data.toString());
    if (meta.status === 'OK' && meta.location) {
      return { pano_lat: meta.location.lat, pano_lng: meta.location.lng };
    }
  } catch {}
  return null;
}

/**
 * Compute bearing (heading) from point A to point B in degrees.
 */
function computeBearing(lat1, lng1, lat2, lng2) {
  const toRad = d => d * Math.PI / 180;
  const toDeg = r => r * 180 / Math.PI;
  const dLng = toRad(lng2 - lng1);
  const y = Math.sin(dLng) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Fetch Google Street View image as a base64 string.
 * Computes the heading from the camera position toward the property
 * so the image actually faces the house, not a random direction.
 */
async function getStreetView(lat, lng) {
  if (!API_KEY) throw new Error('GOOGLE_MAPS_API_KEY not set');

  // Get the actual panorama location (where the Street View car was)
  let heading = 0;
  const meta = await getStreetViewMeta(lat, lng);
  if (meta) {
    // Compute bearing from camera to property
    heading = Math.round(computeBearing(meta.pano_lat, meta.pano_lng, lat, lng));
    console.log(`[streetview] Camera at ${meta.pano_lat},${meta.pano_lng} → property at ${lat},${lng} = heading ${heading}°`);
  }

  const url = `https://maps.googleapis.com/maps/api/streetview?size=640x480&fov=90&heading=${heading}&pitch=5&location=${lat},${lng}&key=${API_KEY}`;

  try {
    const buffer = await httpGet(url, true);
    try { const { logGoogle } = require('./costs'); await logGoogle('google_streetview'); } catch {}
    return buffer.toString('base64');
  } catch (err) {
    console.error('Street View error:', err.message);
    return null;
  }
}

/**
 * Fetch Google Maps satellite image as a base64 string.
 * Parameters: size=640x480, zoom=20, maptype=satellite.
 */
async function getSatelliteView(lat, lng) {
  if (!API_KEY) throw new Error('GOOGLE_MAPS_API_KEY not set');

  const url = `https://maps.googleapis.com/maps/api/staticmap?size=640x480&zoom=20&maptype=satellite&center=${lat},${lng}&key=${API_KEY}`;

  try {
    const buffer = await httpGet(url, true);
    try { const { logGoogle } = require('./costs'); await logGoogle('google_static_map'); } catch {}
    return buffer.toString('base64');
  } catch (err) {
    console.error('Satellite view error:', err.message);
    return null;
  }
}

/**
 * Full maps pipeline for an address:
 * 1. Geocode → lat/lng + normalised address
 * 2. Street View → base64 image
 * 3. Satellite view → base64 image
 * 4. Store images in property_images table
 *
 * @param {string} address - Raw address string
 * @param {number} propertyId - Property ID to link images to
 * @returns {{ geocode, streetview_base64, satellite_base64, streetview_image_id, satellite_image_id } | null}
 */
async function lookupAddress(address, propertyId, listingUrl) {
  const geo = await geocode(address, listingUrl);
  if (!geo) return null;

  // Update property with geocoded data
  await pool.query(
    `UPDATE properties
     SET lat = $1, lng = $2, address_normalised = $3, suburb = $4, city = $5, province = $6
     WHERE id = $7`,
    [geo.lat, geo.lng, geo.formatted_address, geo.suburb, geo.city, geo.province, propertyId]
  );

  // Fetch Street View and satellite in parallel
  const [streetviewBase64, satelliteBase64] = await Promise.all([
    getStreetView(geo.lat, geo.lng),
    getSatelliteView(geo.lat, geo.lng),
  ]);

  let streetviewImageId = null;
  let satelliteImageId = null;

  // Store Street View image
  if (streetviewBase64) {
    const { rows } = await pool.query(
      `INSERT INTO property_images (property_id, source, image_url, image_type)
       VALUES ($1, 'streetview', $2, 'exterior')
       RETURNING id`,
      [propertyId, `data:image/jpeg;base64,${streetviewBase64}`]
    );
    streetviewImageId = rows[0].id;
  }

  // Store satellite image
  if (satelliteBase64) {
    const { rows } = await pool.query(
      `INSERT INTO property_images (property_id, source, image_url, image_type)
       VALUES ($1, 'satellite', $2, 'exterior')
       RETURNING id`,
      [propertyId, `data:image/png;base64,${satelliteBase64}`]
    );
    satelliteImageId = rows[0].id;
  }

  return {
    geocode: geo,
    streetview_base64: streetviewBase64,
    satellite_base64: satelliteBase64,
    streetview_image_id: streetviewImageId,
    satellite_image_id: satelliteImageId,
  };
}

module.exports = { geocode, getStreetView, getSatelliteView, lookupAddress };
