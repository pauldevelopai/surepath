import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { withAuth } from "@/lib/auth";
import path from "path";
import fs from "fs";

// Allow long-running vision analysis (up to 5 minutes)
export const maxDuration = 300;

async function loadModule(name: string) {
  const modPath = path.resolve(process.cwd(), "..", `${name}.js`);
  const mod = await import(/* webpackIgnore: true */ modPath);
  return mod.default || mod;
}

function saveImageFile(base64: string, propertyId: string, type: string, ext: string): string {
  const dir = path.resolve(process.cwd(), "public", "property-images");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filename = `${propertyId}-${type}-${Date.now()}.${ext}`;
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, Buffer.from(base64, "base64"));
  return `/property-images/${filename}`;
}

export const POST = withAuth(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const body = await req.json();
  const action = body.action;

  const properties = await query("SELECT * FROM properties WHERE id = $1", [id]);
  if (!properties.length) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const prop = properties[0];
  const provenance = await loadModule("provenance");

  try {
    // ── GEOCODE ──
    if (action === "geocode") {
      if (!process.env.GOOGLE_MAPS_API_KEY) return NextResponse.json({ ok: false, message: "GOOGLE_MAPS_API_KEY not set" });
      const maps = await loadModule("maps");
      const geo = await maps.geocode(prop.address_raw, prop.listing_url);
      if (!geo) return NextResponse.json({ ok: false, message: "Geocoding returned no results" });
      await query(`UPDATE properties SET lat=$1, lng=$2, address_normalised=$3, suburb=COALESCE($4,suburb), city=COALESCE($5,city), province=COALESCE($6,province) WHERE id=$7`,
        [geo.lat, geo.lng, geo.formatted_address, geo.suburb, geo.city, geo.province, id]);
      const mapsUrl = `https://www.google.com/maps/@${geo.lat},${geo.lng},18z`;
      await provenance.recordSource(parseInt(id), "Google Maps Geocoding API", mapsUrl, "verified", ["lat", "lng", "address_normalised", "suburb", "city", "province"]);
      return NextResponse.json({ ok: true, message: `Geocoded: ${geo.lat}, ${geo.lng} — ${geo.formatted_address}` });
    }

    // ── STREET VIEW ──
    if (action === "streetview") {
      if (!prop.lat) return NextResponse.json({ ok: false, message: "Geocode first" });
      if (!process.env.GOOGLE_MAPS_API_KEY) return NextResponse.json({ ok: false, message: "GOOGLE_MAPS_API_KEY not set" });
      const maps = await loadModule("maps");
      const lat = parseFloat(prop.lat); const lng = parseFloat(prop.lng);
      const base64 = await maps.getStreetView(lat, lng);
      if (!base64) return NextResponse.json({ ok: false, message: "No Street View coverage" });

      const localUrl = saveImageFile(base64, id, "streetview", "jpg");
      await query("DELETE FROM property_images WHERE property_id=$1 AND source='streetview'", [id]);
      await query("INSERT INTO property_images (property_id, source, image_url, image_type) VALUES ($1,'streetview',$2,'exterior')", [id, localUrl]);

      const svUrl = `https://www.google.com/maps/@${lat},${lng},3a,75y,0h,90t/data=!3m1!1e1`;
      await provenance.recordSource(parseInt(id), "Google Street View", svUrl, "verified", []);
      return NextResponse.json({ ok: true, message: "Street View captured and saved" });
    }

    // ── SATELLITE ──
    if (action === "satellite") {
      if (!prop.lat) return NextResponse.json({ ok: false, message: "Geocode first" });
      if (!process.env.GOOGLE_MAPS_API_KEY) return NextResponse.json({ ok: false, message: "GOOGLE_MAPS_API_KEY not set" });
      const maps = await loadModule("maps");
      const lat = parseFloat(prop.lat); const lng = parseFloat(prop.lng);
      const base64 = await maps.getSatelliteView(lat, lng);
      if (!base64) return NextResponse.json({ ok: false, message: "Satellite unavailable" });

      const localUrl = saveImageFile(base64, id, "satellite", "png");
      await query("DELETE FROM property_images WHERE property_id=$1 AND source='satellite'", [id]);
      await query("INSERT INTO property_images (property_id, source, image_url, image_type) VALUES ($1,'satellite',$2,'exterior')", [id, localUrl]);

      const satUrl = `https://www.google.com/maps/@${lat},${lng},20z/data=!3m1!1e1!3m1!1e3`;
      await provenance.recordSource(parseInt(id), "Google Maps Satellite", satUrl, "verified", []);
      return NextResponse.json({ ok: true, message: "Satellite captured and saved" });
    }

    // ── RE-SCRAPE PHOTOS ──
    if (action === "rescrape") {
      if (!prop.listing_url) return NextResponse.json({ ok: false, message: "No listing URL" });

      const puppeteer = await import("puppeteer");
      const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
      const page = await browser.newPage();
      await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36");
      await page.goto(prop.listing_url, { waitUntil: "networkidle0", timeout: 30000 });
      await new Promise(r => setTimeout(r, 3000));

      // Try to click "See all photos" button to load the gallery
      try {
        await page.click('[class*="see-all"], [class*="photo-count"], [class*="gallery"]');
        await new Promise(r => setTimeout(r, 2000));
      } catch { /* no gallery button */ }

      const photos: string[] = await page.evaluate(() => {
        const found: string[] = [];
        const seen = new Set<string>();
        function add(url: string) {
          if (!url || seen.has(url) || url.includes("NoImage") || url.includes("blank") || url.includes("icon") || url.includes(".svg") || url.includes(".gif")) return;
          seen.add(url);
          found.push(url);
        }

        // Get all image sources including lazy-loaded and background images
        document.querySelectorAll("img[src], img[data-src], img[data-lazy-src], [style*='background-image']").forEach((el: Element) => {
          const htmlEl = el as HTMLElement;
          let src = (el as HTMLImageElement).src || htmlEl.dataset?.src || htmlEl.dataset?.lazySrc || "";
          if (!src && htmlEl.style?.backgroundImage) {
            const m = htmlEl.style.backgroundImage.match(/url\(["']?([^"')]+)/);
            if (m) src = m[1];
          }

          // Property24 images
          if (src.includes("images.prop24.com")) {
            add(src.replace(/\/Fit\d+x\d+/, "/Ensure960x540").replace(/\/Crop\d+x\d+/, "/Ensure960x540"));
          }
          // PrivateProperty images
          if (src.includes("images.pp.co.za")) {
            add(src.replace(/\/\d+\/\d+\/contain/, "/1600/1066/contain"));
          }
        });

        // Scan HTML source for image CDN URLs (catches lazy-loaded, JSON data, etc.)
        const html = document.documentElement.innerHTML;

        // Property24 images in scripts/JSON
        const p24Matches = html.matchAll(/https:\/\/images\.prop24\.com\/\d+\/[A-Za-z0-9]+/g);
        for (const m of p24Matches) add(m[0]);

        // PrivateProperty images in scripts/JSON
        const ppMatches = html.matchAll(/https:\/\/images\.pp\.co\.za\/listing\/\d+\/[A-Za-z0-9_-]+/g);
        for (const m of ppMatches) add(m[0] + "/1600/1066/contain/jpegorpng");

        return found;
      });
      await browser.close();

      // Determine source based on listing URL
      const imgSource = prop.listing_url?.includes("privateproperty") ? "privateproperty" : "property24";

      // Delete old photos for this property from same source, store fresh ones
      await query("DELETE FROM property_images WHERE property_id=$1 AND source=$2", [id, imgSource]);
      let stored = 0;
      const seen = new Set<string>();
      for (const url of photos) {
        // Dedupe by image hash (the unique ID part of the URL)
        const imgId = url.match(/prop24\.com\/(\d+)/)?.[1] || url.match(/pp\.co\.za\/listing\/\d+\/([A-Za-z0-9_-]+)/)?.[1];
        if (imgId && seen.has(imgId)) continue;
        if (imgId) seen.add(imgId);

        await query("INSERT INTO property_images (property_id, source, image_url, image_type) VALUES ($1,$2,$3,'listing')", [id, imgSource, url]);
        stored++;
      }

      await query("UPDATE properties SET last_scraped_at = NOW() WHERE id = $1", [id]);
      return NextResponse.json({ ok: true, message: `Found ${photos.length} image URLs, stored ${stored} unique photos` });
    }

    // ── ANALYSE STREET VIEW ──
    if (action === "analyse_streetview") {
      const svImg = await query("SELECT id, image_url FROM property_images WHERE property_id=$1 AND source='streetview' LIMIT 1", [id]);
      if (!svImg.length) return NextResponse.json({ ok: false, message: "No Street View image. Capture first." });

      const imgPath = path.resolve(process.cwd(), "public", svImg[0].image_url.replace(/^\//, ""));
      if (!fs.existsSync(imgPath)) return NextResponse.json({ ok: false, message: "Image file not found" });

      const base64 = fs.readFileSync(imgPath).toString("base64");
      const vision = await loadModule("vision");
      const analysis = await vision.analyseStreetView(base64);

      await query("UPDATE property_images SET vision_analysis=$1, analysed_at=NOW() WHERE id=$2", [JSON.stringify(analysis), svImg[0].id]);

      // Save findings to property
      if (analysis.roof_material && analysis.roof_material !== "unknown") await query("UPDATE properties SET roof_material=$1 WHERE id=$2", [analysis.roof_material, id]);
      if (analysis.security_visible) await query("UPDATE properties SET security_visible=TRUE WHERE id=$1", [id]);

      // Run specialist exterior security analysis
      let specialistCount = 0;
      try {
        const secResult = await vision.analyseExteriorSecurity(base64);
        await query("UPDATE property_images SET vision_analysis = vision_analysis || $1::jsonb WHERE id = $2",
          [JSON.stringify({ security_assessment: secResult.security_assessment, specialist_findings: secResult.findings }), svImg[0].id]);
        specialistCount++;
      } catch (e: unknown) { console.error("[analyse_streetview] Security specialist error:", e instanceof Error ? e.message : e); }

      const findingCount = (analysis.findings || []).length;
      return NextResponse.json({ ok: true, message: `Street View analysed: ${findingCount} findings + ${specialistCount} specialist modules` });
    }

    // ── ANALYSE SATELLITE ──
    if (action === "analyse_satellite") {
      const satImg = await query("SELECT id, image_url FROM property_images WHERE property_id=$1 AND source='satellite' LIMIT 1", [id]);
      if (!satImg.length) return NextResponse.json({ ok: false, message: "No satellite image. Capture first." });

      const imgPath = path.resolve(process.cwd(), "public", satImg[0].image_url.replace(/^\//, ""));
      if (!fs.existsSync(imgPath)) return NextResponse.json({ ok: false, message: "Image file not found" });

      const base64 = fs.readFileSync(imgPath).toString("base64");
      const vision = await loadModule("vision");
      const analysis = await vision.analyseSatellite(base64);

      await query("UPDATE property_images SET vision_analysis=$1, analysed_at=NOW() WHERE id=$2", [JSON.stringify(analysis), satImg[0].id]);

      // Save derived fields
      if (analysis.roof_material && analysis.roof_material !== "unknown") {
        await query("UPDATE properties SET roof_material=$1 WHERE id=$2", [analysis.roof_material, id]);
        await provenance.recordSource(parseInt(id), "Claude Satellite Analysis", "https://console.anthropic.com", "estimated", ["roof_material"]);
      }
      if (analysis.roof_orientation_estimate && analysis.roof_orientation_estimate !== "unclear") {
        await query("UPDATE properties SET roof_orientation=$1 WHERE id=$2", [analysis.roof_orientation_estimate, id]);
        await provenance.recordSource(parseInt(id), "Claude Satellite Analysis", "https://console.anthropic.com", "estimated", ["roof_orientation"]);
      }
      if (analysis.solar_installed) await query("UPDATE properties SET solar_installed=TRUE WHERE id=$1", [id]);

      const findingCount = (analysis.findings || []).length;
      return NextResponse.json({ ok: true, message: `Satellite analysed: roof=${analysis.roof_material}, orientation=${analysis.roof_orientation_estimate}, ${findingCount} findings` });
    }

    // ── VISION ANALYSIS (listing photos) ──
    if (action === "vision") {
      const selectedIds: number[] = body.image_ids || [];

      // Get images to analyse
      let imgs;
      if (selectedIds.length > 0) {
        imgs = await query("SELECT id, image_url, source FROM property_images WHERE property_id=$1 AND id = ANY($2::int[])", [id, selectedIds]);
      } else {
        imgs = await query("SELECT id, image_url, source FROM property_images WHERE property_id=$1 AND vision_analysis IS NULL", [id]);
      }

      // If "analyse all" was clicked but all are already analysed, analyse all anyway
      if (imgs.length === 0 && selectedIds.length === 0) {
        imgs = await query("SELECT id, image_url, source FROM property_images WHERE property_id=$1", [id]);
      }

      if (imgs.length === 0) return NextResponse.json({ ok: false, message: "No images to analyse" });

      // Build context from what our system already knows about this property
      const systemContext: string[] = [];
      if (prop.construction_era) systemContext.push(`Construction era: ${prop.construction_era}`);
      if (prop.property_type) systemContext.push(`Property type: ${prop.property_type}`);
      if (prop.suburb) systemContext.push(`Location: ${prop.suburb}, ${prop.city}`);
      if (prop.dolomite_risk) systemContext.push(`Dolomite/sinkhole risk for this area: ${prop.dolomite_risk}`);
      if (prop.flood_zone) systemContext.push(`Property is in a flood zone (${prop.flood_zone_type})`);
      if (prop.sewerage_quality_score && prop.sewerage_quality_score <= 4) systemContext.push(`Area has poor sewerage quality (${prop.sewerage_quality_score}/10)`);
      if (prop.heritage_site) systemContext.push("Property is in a heritage area — look for heritage features");

      // Get area stats for context
      const areaStats = await query(
        `SELECT COUNT(*) AS total, AVG(p2.asking_price) AS avg_price,
          COUNT(*) FILTER (WHERE pr.asbestos_risk IN ('HIGH','CRITICAL')) AS asbestos_count
         FROM properties p2
         LEFT JOIN property_reports pr ON pr.property_id = p2.id
         WHERE p2.suburb ILIKE $1 AND p2.city ILIKE $2`,
        [prop.suburb || "", prop.city || ""]
      );
      if (areaStats[0]?.total > 0) {
        systemContext.push(`Our system has ${areaStats[0].total} properties in ${prop.suburb}. ${areaStats[0].asbestos_count} have asbestos risk flags.`);
      }

      // Pass context to vision module via environment
      if (systemContext.length > 0) {
        process.env.SUREPATH_VISION_CONTEXT = systemContext.join(". ");
      }

      // Filter to only HTTP URLs (skip local paths and base64)
      const httpUrls = imgs.map((i: { image_url: string }) => i.image_url).filter((u: string) => u.startsWith("http"));

      if (httpUrls.length === 0) {
        return NextResponse.json({ ok: false, message: "No downloadable images — Street View and satellite are stored locally and cannot be sent to Claude directly yet" });
      }

      const vision = await loadModule("vision");
      // Use HF-enhanced pipeline if available, fall back to standard if function not found (module cache)
      const analyseFn = vision.analyseWithHFPrestage || vision.analysePropertyImages;
      const result = typeof analyseFn === 'function'
        ? await (vision.analyseWithHFPrestage ? analyseFn(parseInt(id), httpUrls) : analyseFn(httpUrls, parseInt(id)))
        : null;
      if (!result) return NextResponse.json({ ok: false, message: "Vision analysis returned no results" });

      // Store aggregated results into property + report
      const agg = result.aggregated;

      // Update property with vision-derived fields
      const visionFields: string[] = [];
      if (agg.roof_material && agg.roof_material !== "unknown") {
        await query("UPDATE properties SET roof_material=$1 WHERE id=$2", [agg.roof_material, id]);
        visionFields.push("roof_material");
      }
      if (agg.roof_orientation && agg.roof_orientation !== "unclear") {
        await query("UPDATE properties SET roof_orientation=$1 WHERE id=$2", [agg.roof_orientation, id]);
        visionFields.push("roof_orientation");
      }
      if (agg.solar_installed != null) {
        await query("UPDATE properties SET solar_installed=$1 WHERE id=$2", [agg.solar_installed, id]);
        visionFields.push("solar_installed");
      }
      if (agg.security_visible != null) {
        await query("UPDATE properties SET security_visible=$1 WHERE id=$2", [agg.security_visible, id]);
        visionFields.push("security_visible");
      }

      // Store/update report with vision findings — MERGE with existing, don't overwrite
      const existing = await query("SELECT id, vision_findings FROM property_reports WHERE property_id=$1", [id]);
      if (existing.length > 0) {
        // Merge new findings with existing ones
        const existingFindings = Array.isArray(existing[0].vision_findings) ? existing[0].vision_findings : [];
        const mergedFindings = [...existingFindings, ...agg.vision_findings];
        // Deduplicate by observation text
        const seen = new Set();
        const dedupedFindings = mergedFindings.filter(f => {
          const key = (f.observation || f.finding || "").toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

        await query(`UPDATE property_reports SET
          vision_findings=$1, asbestos_risk=$2, structural_flags=$3, compliance_flags=$4,
          repair_estimates=$5, insurance_risk_score=$6, insurance_flags=$7,
          solar_suitability_score=$8, trades_flags=$9, maintenance_cost_estimate=$10,
          last_refreshed_at=NOW()
          WHERE property_id=$11`,
          [JSON.stringify(dedupedFindings), agg.asbestos_risk,
           JSON.stringify(agg.structural_flags), JSON.stringify(agg.compliance_flags),
           JSON.stringify(agg.repair_estimates), agg.insurance_risk_score, JSON.stringify(agg.insurance_flags),
           agg.solar_suitability_score, JSON.stringify(agg.trades_flags), agg.maintenance_cost_estimate, id]);
      } else {
        await query(`INSERT INTO property_reports (property_id, vision_findings, asbestos_risk,
          structural_flags, compliance_flags, repair_estimates,
          insurance_risk_score, insurance_flags, solar_suitability_score,
          trades_flags, maintenance_cost_estimate,
          decision, decision_reasoning, status)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'NEGOTIATE','Vision-only analysis','complete')`,
          [id, JSON.stringify(agg.vision_findings), agg.asbestos_risk,
           JSON.stringify(agg.structural_flags), JSON.stringify(agg.compliance_flags),
           JSON.stringify(agg.repair_estimates), agg.insurance_risk_score, JSON.stringify(agg.insurance_flags),
           agg.solar_suitability_score, JSON.stringify(agg.trades_flags), agg.maintenance_cost_estimate]);
      }

      if (visionFields.length > 0) {
        const today = new Date().toISOString().slice(0, 10);
        await provenance.recordSource(parseInt(id), "Claude Vision Analysis",
          `https://console.anthropic.com/settings/logs?date=${today}`, "estimated", visionFields);
      }

      return NextResponse.json({
        ok: true,
        message: `Analysed ${result.analyses.length} images: ${agg.vision_findings.length} findings, insurance=${agg.insurance_risk_score}/10, solar=${agg.solar_suitability_score}/10, asbestos=${agg.asbestos_risk}. Results saved to database.`,
      });
    }

    // ── DEEDS ──
    if (action === "deeds") {
      if (!process.env.WINDEED_API_KEY) return NextResponse.json({ ok: false, message: "WINDEED_API_KEY not configured" });
      const windeed = await loadModule("windeed");
      const result = await windeed.lookupAddress(prop.address_raw);
      if (!result) return NextResponse.json({ ok: false, message: "Windeed returned no results" });
      await provenance.recordSource(parseInt(id), "Windeed Deeds Office",
        `https://www.windeed.co.za/property/${result.erf_number}`, "verified", ["erf_number"]);
      return NextResponse.json({ ok: true, message: `ERF ${result.erf_number} — Owner: ${result.registered_owner}` });
    }

    // ── EXTRACT FEATURES ──
    if (action === "extract") {
      if (!prop.description) return NextResponse.json({ ok: false, message: "No description" });
      const extractor = await loadModule("extract-features");
      const result = await extractor.processProperty(parseInt(id));
      return NextResponse.json({ ok: true, message: `Extracted ${result.fields_updated} fields: ${(result.fields || []).join(", ")}` });
    }

    // ── RISK DATA ──
    if (action === "risk") {
      const riskPath = path.resolve(process.cwd(), "..", "bootstrap", "collect-risk-data.js");
      // Run inline — collect risks for this property's city/suburb
      const results: string[] = [];

      // Water quality — real Blue/Green Drop scores digitized from DWS PDF reports
      try {
        const municipal = await loadModule("collect-municipal");
        const waterResult = await municipal.collectForProperty(parseInt(id));
        if (waterResult?.water_quality_score != null) {
          results.push(`Water: ${waterResult.water_quality_score}/10 (Blue Drop ${waterResult.blue_drop_percent}%), Sewerage: ${waterResult.sewerage_quality_score}/10 (Green Drop ${waterResult.green_drop_percent}%)`);
        } else {
          results.push(`Water quality: no Blue/Green Drop data for ${prop.city || 'this municipality'} — DWS report does not cover this area`);
        }
      } catch (e: unknown) {
        results.push("Water quality: " + (e instanceof Error ? e.message : "failed"));
      }

      // Solar — real data from EU PVGIS API
      if (prop.lat) {
        try {
          const solarMod = await loadModule("collect-solar");
          const solar = await solarMod.getSolarData(parseInt(id));
          if (solar) results.push(`Solar: GHI=${solar.ghi_kwh_m2_year} kWh/m²/year, PV output=${solar.pv_output_kwh_year} kWh/year (PVGIS verified)`);
        } catch (e: unknown) {
          results.push("Solar: " + (e instanceof Error ? e.message : "failed"));
        }
      }

      // Compliance
      await query("UPDATE properties SET electrical_coc_required=TRUE WHERE id=$1", [id]);
      if (prop.city === "Cape Town") await query("UPDATE properties SET plumbing_coc_required=TRUE WHERE id=$1", [id]);
      if (["Western Cape", "KwaZulu-Natal"].includes(prop.province)) await query("UPDATE properties SET beetle_cert_required=TRUE WHERE id=$1", [id]);
      results.push("Compliance rules applied");

      await provenance.recordSource(parseInt(id), "SA National Building Regulations",
        "https://www.sahomeloans.com/bond-talk/guide-compliance-certificates", "verified",
        ["electrical_coc_required", "plumbing_coc_required", "beetle_cert_required"]);

      return NextResponse.json({ ok: true, message: results.join(". ") });
    }

    // ── CRIME DATA (CrimeHub/SAPS) ──
    if (action === "crime") {
      try {
        const crimeMod = await loadModule("collect-crime");
        const result = await crimeMod.collectForProperty(parseInt(id));
        if (result?.error) return NextResponse.json({ ok: false, message: result.error });
        return NextResponse.json({ ok: true, message: `${result.station}: ${result.total} incidents (${result.year}). Source: CrimeHub/SAPS verified data.` });
      } catch (e: unknown) {
        return NextResponse.json({ ok: false, message: e instanceof Error ? e.message : "Crime data failed" });
      }
    }

    // ── SOCIAL LISTENING ──
    if (action === "social") {
      if (!prop.lat) return NextResponse.json({ ok: false, message: "Geocode first" });
      try {
        const social = await loadModule("collect-social");
        const result = await social.collectForProperty(parseInt(id));
        if (!result) return NextResponse.json({ ok: false, message: "No data returned" });
        return NextResponse.json({
          ok: true,
          message: `Scanned ${result.places_scanned} nearby places, ${result.summary.total_reviews_scanned} reviews. Found ${result.concerns.length} concerns (${result.summary.noise_mentions} noise, ${result.summary.traffic_mentions} traffic, ${result.summary.safety_mentions} safety).`,
          data: result,
        });
      } catch (e: unknown) {
        return NextResponse.json({ ok: false, message: e instanceof Error ? e.message : "Neighbourhood scan failed" });
      }
    }

    if (action === "security") {
      if (!prop.lat) return NextResponse.json({ ok: false, message: "Geocode first" });
      try {
        const security = await loadModule("collect-security");
        const result = await security.collectForProperty(parseInt(id));
        if (!result) return NextResponse.json({ ok: false, message: "No data returned" });
        return NextResponse.json({
          ok: true,
          message: `Found ${result.security_companies_count} security companies. CPF: ${result.cpf_found ? "yes" : "no"}. NHW: ${result.nhw_found ? "yes" : "no"}. Sentiment: ${result.sentiment_overall}.`,
          data: result,
        });
      } catch (e: unknown) {
        return NextResponse.json({ ok: false, message: e instanceof Error ? e.message : "Security collection failed" });
      }
    }

    // ── SCHOOLS ──
    if (action === "schools") {
      if (!prop.lat) return NextResponse.json({ ok: false, message: "Geocode first" });
      try {
        const mod = await loadModule("collect-schools");
        const result = await mod.collectForProperty(parseInt(id));
        if (!result) return NextResponse.json({ ok: false, message: "No data returned" });
        return NextResponse.json({ ok: true, message: `Found ${result.total_found || '?'} schools within 3km. Score: ${result.score || '?'}/10.` });
      } catch (e: unknown) {
        return NextResponse.json({ ok: false, message: e instanceof Error ? e.message : "Schools collection failed" });
      }
    }

    // ── CLIMATE ──
    if (action === "climate") {
      if (!prop.lat) return NextResponse.json({ ok: false, message: "Geocode first" });
      try {
        const mod = await loadModule("collect-climate");
        const result = await mod.collectForProperty(parseInt(id));
        if (!result || result.error) return NextResponse.json({ ok: false, message: result?.error || "No climate data" });
        return NextResponse.json({ ok: true, message: `Climate: ${result.annual_rainfall_mm}mm/yr, ${result.avg_humidity}% humidity, damp risk ${result.damp_risk}.` });
      } catch (e: unknown) {
        return NextResponse.json({ ok: false, message: e instanceof Error ? e.message : "Climate collection failed" });
      }
    }

    // ── SOLD PRICES ──
    if (action === "soldprices") {
      try {
        const mod = await loadModule("collect-sold-prices");
        const result = await mod.collectForProperty(parseInt(id));
        if (!result || result.error) return NextResponse.json({ ok: false, message: result?.error || "No sold price data" });
        return NextResponse.json({ ok: true, message: `Found ${result.total_sales || '?'} recent sales. Median: R${result.median_price?.toLocaleString() || '?'}.` });
      } catch (e: unknown) {
        return NextResponse.json({ ok: false, message: e instanceof Error ? e.message : "Sold prices failed" });
      }
    }

    // ── FIBRE ──
    if (action === "fibre") {
      if (!prop.lat) return NextResponse.json({ ok: false, message: "Geocode first" });
      try {
        const mod = await loadModule("collect-fibre");
        const result = await mod.collectForProperty(parseInt(id));
        if (!result || result.error) return NextResponse.json({ ok: false, message: result?.error || "No fibre data" });
        return NextResponse.json({ ok: true, message: `Fibre: ${result.coverage || '?'} coverage. ${result.providers || 0} providers.` });
      } catch (e: unknown) {
        return NextResponse.json({ ok: false, message: e instanceof Error ? e.message : "Fibre collection failed" });
      }
    }

    // ── ELECTRICITY (tariffs + load shedding status) ──
    if (action === "electricity") {
      try {
        const mod = await loadModule("collect-electricity");
        const result = await mod.collectForProperty(parseInt(id));
        if (!result || result.error) return NextResponse.json({ ok: false, message: result?.error || "No electricity data" });
        return NextResponse.json({ ok: true, message: `Electricity: R${result.monthly_total_rands}/month at R${result.rate_per_kwh_rands}/kWh (${result.supplier}). Load shedding: ${result.load_shedding_status}` });
      } catch (e: unknown) {
        return NextResponse.json({ ok: false, message: e instanceof Error ? e.message : "Electricity collection failed" });
      }
    }

    // ── LOAD SHEDDING ──
    if (action === "loadshedding") {
      try {
        const mod = await loadModule("collect-loadshedding");
        const result = await mod.collectForProperty(parseInt(id));
        if (!result || result.error) return NextResponse.json({ ok: false, message: result?.error || "No loadshedding data" });
        return NextResponse.json({ ok: true, message: `Load shedding: Group ${result.group || '?'}. ${result.area || ''}` });
      } catch (e: unknown) {
        return NextResponse.json({ ok: false, message: e instanceof Error ? e.message : "Loadshedding collection failed" });
      }
    }

    // ── PRICE TRENDS ──
    if (action === "pricetrends") {
      try {
        const mod = await loadModule("collect-price-trends");
        const result = await mod.collectForProperty(parseInt(id));
        if (!result || result.error) return NextResponse.json({ ok: false, message: result?.error || "No price trend data" });
        return NextResponse.json({ ok: true, message: `Price trends: avg ${result.internal_data?.avg_price ? 'R' + result.internal_data.avg_price.toLocaleString() : 'N/A'}, ${result.regional_trend?.trend || 'unknown'} market` });
      } catch (e: unknown) {
        return NextResponse.json({ ok: false, message: e instanceof Error ? e.message : "Price trends failed" });
      }
    }

    // ── PROPERTY COSTS ──
    if (action === "propertycosts") {
      try {
        const mod = await loadModule("collect-property-costs");
        const result = await mod.collectForProperty(parseInt(id));
        if (!result || result.error) return NextResponse.json({ ok: false, message: result?.error || "No cost data" });
        return NextResponse.json({ ok: true, message: `Real cost: R${result.real_purchase_cost?.toLocaleString()} (+${result.premium_over_asking_pct}% over asking)` });
      } catch (e: unknown) {
        return NextResponse.json({ ok: false, message: e instanceof Error ? e.message : "Cost calculation failed" });
      }
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, message: msg }, { status: 500 });
  }
});
