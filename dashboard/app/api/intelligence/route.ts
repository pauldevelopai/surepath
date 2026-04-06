import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { withAuth } from "@/lib/auth";

// ─── GET: Load all data for the Intelligence Hub page ─────────────────
export const GET = withAuth(async (req: NextRequest) => {
  const section = req.nextUrl.searchParams.get("section");

  // ─── Summary cards (always returned) ────────────────────────────────
  if (section === "summary" || !section) {
    const [reportStats, imageStats, propertyStats, deedsStats, crimeStats, kbStats, qualityStats] = await Promise.all([
      query(`SELECT
        COUNT(DISTINCT property_id) AS unique_properties,
        COUNT(*) AS total_reports,
        COUNT(*) FILTER (WHERE status = 'complete') AS complete_reports,
        COUNT(*) FILTER (WHERE insurance_risk_score IS NOT NULL) AS with_scores,
        COUNT(*) FILTER (WHERE structural_flags IS NOT NULL AND jsonb_typeof(structural_flags) = 'array' AND jsonb_array_length(structural_flags) > 0) AS with_structural,
        COUNT(*) FILTER (WHERE generation_cost_zar IS NOT NULL AND generation_cost_zar > 0) AS with_cost
      FROM property_reports`),
      query(`SELECT
        (SELECT COUNT(DISTINCT property_id) FROM property_images WHERE vision_analysis IS NOT NULL) AS properties_analysed,
        (SELECT COUNT(*) FROM property_images) AS total_images,
        (SELECT COUNT(*) FROM property_images WHERE vision_analysis IS NOT NULL) AS analysed_images,
        (SELECT SUM(jsonb_array_length(vision_analysis->'findings')) FROM property_images WHERE vision_analysis IS NOT NULL AND jsonb_typeof(vision_analysis->'findings') = 'array') AS total_findings
      `),
      query(`SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE lat IS NOT NULL) AS geocoded,
        COUNT(*) FILTER (WHERE construction_era IS NOT NULL) AS with_era,
        COUNT(*) FILTER (WHERE roof_material IS NOT NULL) AS with_roof,
        COUNT(*) FILTER (WHERE suburb_crime_score IS NOT NULL) AS with_crime
      FROM properties`),
      query(`SELECT COUNT(DISTINCT property_id) AS c FROM deeds_data`),
      query(`SELECT COUNT(DISTINCT suburb) AS suburbs, COUNT(*) AS incidents FROM crime_incidents`),
      query(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status = 'active') AS active FROM rag_knowledge_entries`).catch(() => [{ total: 0, active: 0 }]),
      query(`SELECT COUNT(*) AS runs, AVG((score_specificity + score_accuracy + score_actionability + score_consistency) / 4.0) AS avg_score FROM rag_quality_runs WHERE score_specificity IS NOT NULL`).catch(() => [{ runs: 0, avg_score: null }]),
    ]);

    const summary = {
      reports: reportStats[0],
      images: imageStats[0],
      properties: propertyStats[0],
      deeds_coverage: Number(deedsStats[0]?.c || 0),
      crime: crimeStats[0],
      knowledge_base: kbStats[0] || { total: 0, active: 0 },
      quality: qualityStats[0] || { runs: 0, avg_score: null },
    };

    if (section === "summary") return NextResponse.json({ summary });
  }

  // ─── Section 1: Pipeline Monitor ────────────────────────────────────
  // Show latest report per property (deduplicated), with image-level finding counts
  if (section === "pipeline" || !section) {
    const recentRuns = await query(`
      SELECT DISTINCT ON (pr.property_id)
             pr.id, pr.property_id, pr.status, pr.decision, pr.decision_reasoning,
             pr.asking_price, pr.avm_low, pr.avm_high, pr.price_verdict,
             pr.asbestos_risk, pr.insurance_risk_score, pr.crime_risk_score,
             pr.solar_suitability_score, pr.generation_cost_zar,
             pr.vision_findings, pr.structural_flags, pr.compliance_flags,
             pr.repair_estimates, pr.negotiation_intel, pr.insurance_flags,
             pr.suburb_intelligence, pr.created_at,
             p.erf_number, p.address_raw, p.address_normalised, p.suburb, p.city,
             p.construction_era, p.roof_material,
             d.registered_owner, d.municipal_value, d.title_deed_ref
      FROM property_reports pr
      JOIN properties p ON p.id = pr.property_id
      LEFT JOIN LATERAL (
        SELECT registered_owner, municipal_value, title_deed_ref
        FROM deeds_data WHERE property_id = p.id ORDER BY fetched_at DESC LIMIT 1
      ) d ON true
      ORDER BY pr.property_id, pr.created_at DESC
    `);

    // Sort by most recent report first (DISTINCT ON requires ORDER BY property_id first)
    recentRuns.sort((a: Record<string, unknown>, b: Record<string, unknown>) =>
      new Date(b.created_at as string).getTime() - new Date(a.created_at as string).getTime()
    );

    // Get image counts and finding counts from property_images (the real source)
    for (const run of recentRuns) {
      const imgs = await query(
        `SELECT COUNT(*) AS total,
                COUNT(*) FILTER (WHERE vision_analysis IS NOT NULL) AS analysed,
                SUM(CASE WHEN vision_analysis IS NOT NULL AND jsonb_typeof(vision_analysis->'findings') = 'array'
                    THEN jsonb_array_length(vision_analysis->'findings') ELSE 0 END) AS finding_count
         FROM property_images WHERE property_id = $1`,
        [run.property_id]
      );
      run.image_count = Number(imgs[0]?.total || 0);
      run.analysed_count = Number(imgs[0]?.analysed || 0);
      run.finding_count = Number(imgs[0]?.finding_count || 0);
    }

    if (section === "pipeline") return NextResponse.json({ pipeline: recentRuns });
  }

  // ─── Section 2: Knowledge Base ──────────────────────────────────────
  if (section === "knowledge" || !section) {
    let knowledgeEntries: Record<string, unknown>[] = [];
    try {
      knowledgeEntries = await query(
        `SELECT * FROM rag_knowledge_entries ORDER BY status DESC, severity DESC`
      );
    } catch { /* table doesn't exist yet */ }

    // Analysed photos with findings — for the photo browser
    const analysedPhotos = await query(`
      SELECT pi.id AS image_id, pi.property_id, pi.image_url, pi.image_type,
             pi.vision_analysis->'findings' AS findings,
             pi.vision_analysis->>'photo_type' AS photo_type,
             pi.analysed_at,
             p.address_raw, p.suburb, p.city
      FROM property_images pi
      JOIN properties p ON p.id = pi.property_id
      WHERE pi.vision_analysis IS NOT NULL
        AND jsonb_typeof(pi.vision_analysis->'findings') = 'array'
        AND jsonb_array_length(pi.vision_analysis->'findings') > 0
      ORDER BY pi.analysed_at DESC NULLS LAST
      LIMIT 50
    `);

    const sourceCoverage = await query(`
      SELECT
        COUNT(*) AS total_properties,
        COUNT(*) FILTER (WHERE lat IS NOT NULL) AS geocoded,
        COUNT(*) FILTER (WHERE construction_era IS NOT NULL) AS with_era,
        COUNT(*) FILTER (WHERE roof_material IS NOT NULL) AS with_roof,
        COUNT(*) FILTER (WHERE suburb_crime_score IS NOT NULL) AS with_crime
      FROM properties
    `);

    const [deedsCoverage, visionCoverage] = await Promise.all([
      query(`SELECT COUNT(DISTINCT property_id) AS properties_with_deeds FROM deeds_data`),
      query(`SELECT COUNT(DISTINCT property_id) AS properties_with_vision FROM property_images WHERE vision_analysis IS NOT NULL`),
    ]);

    if (section === "knowledge") {
      return NextResponse.json({
        knowledge: {
          entries: knowledgeEntries,
          analysed_photos: analysedPhotos,
          coverage: {
            ...sourceCoverage[0],
            properties_with_deeds: Number(deedsCoverage[0]?.properties_with_deeds || 0),
            properties_with_vision: Number(visionCoverage[0]?.properties_with_vision || 0),
          },
        },
      });
    }
  }

  // ─── Section 3: Quality ─────────────────────────────────────────────
  if (section === "quality" || !section) {
    let qualityRuns: Record<string, unknown>[] = [];
    try {
      qualityRuns = await query(`
        SELECT qr.*, p.address_raw, p.suburb
        FROM rag_quality_runs qr
        LEFT JOIN properties p ON p.id = qr.property_id
        ORDER BY qr.created_at DESC LIMIT 30
      `);
    } catch {}

    let scoreTrajectory: Record<string, unknown>[] = [];
    try {
      scoreTrajectory = await query(`
        SELECT created_at::date AS day, run_type, rag_system,
               AVG(score_specificity) AS avg_specificity,
               AVG(score_accuracy) AS avg_accuracy,
               AVG(score_actionability) AS avg_actionability,
               AVG(score_consistency) AS avg_consistency,
               COUNT(*) AS runs
        FROM rag_quality_runs
        WHERE score_specificity IS NOT NULL
        GROUP BY day, run_type, rag_system
        ORDER BY day
      `);
    } catch {}

    if (section === "quality") {
      return NextResponse.json({ quality: { runs: qualityRuns, trajectory: scoreTrajectory } });
    }
  }

  // ─── Section 4: Combined Report View ────────────────────────────────
  // Latest report per property, only those with real synthesis data
  if (section === "combined" || !section) {
    const combinedReports = await query(`
      SELECT DISTINCT ON (pr.property_id)
             pr.id, pr.property_id, pr.decision, pr.decision_reasoning,
             pr.asking_price, pr.avm_low, pr.avm_high,
             pr.vision_findings, pr.structural_flags, pr.repair_estimates,
             pr.negotiation_intel, pr.insurance_flags, pr.asbestos_risk,
             pr.suburb_intelligence, pr.compliance_flags,
             pr.insurance_risk_score, pr.crime_risk_score,
             pr.solar_suitability_score, pr.maintenance_cost_estimate,
             pr.generation_cost_zar, pr.created_at,
             p.erf_number, p.address_raw, p.suburb, p.city,
             p.construction_era, p.roof_material, p.solar_installed,
             p.security_visible,
             d.registered_owner, d.municipal_value, d.transfer_history
      FROM property_reports pr
      JOIN properties p ON p.id = pr.property_id
      LEFT JOIN LATERAL (
        SELECT registered_owner, municipal_value, transfer_history
        FROM deeds_data WHERE property_id = p.id ORDER BY fetched_at DESC LIMIT 1
      ) d ON true
      WHERE pr.status = 'complete'
      ORDER BY pr.property_id, pr.created_at DESC
    `);

    combinedReports.sort((a: Record<string, unknown>, b: Record<string, unknown>) =>
      new Date(b.created_at as string).getTime() - new Date(a.created_at as string).getTime()
    );

    let combinedQuality: Record<string, unknown>[] = [];
    try {
      combinedQuality = await query(`
        SELECT * FROM rag_quality_runs WHERE run_type = 'combined' ORDER BY created_at DESC LIMIT 10
      `);
    } catch {}

    if (section === "combined") {
      return NextResponse.json({ combined: { reports: combinedReports, quality: combinedQuality } });
    }
  }

  // ─── Section 5: Applications ────────────────────────────────────────
  if (section === "applications" || !section) {
    const stats = await query(`
      SELECT
        COUNT(*) AS total_reports,
        COUNT(DISTINCT property_id) AS unique_properties,
        COUNT(*) FILTER (WHERE status = 'complete') AS complete_reports,
        COUNT(*) FILTER (WHERE insurance_risk_score IS NOT NULL) AS with_scores,
        COUNT(*) FILTER (WHERE vision_findings IS NOT NULL AND jsonb_typeof(vision_findings) = 'array' AND jsonb_array_length(vision_findings) > 0) AS with_vision
      FROM property_reports
    `);

    const visionStats = await query(`
      SELECT COUNT(DISTINCT property_id) AS properties_analysed,
             COUNT(*) AS total_images_analysed
      FROM property_images WHERE vision_analysis IS NOT NULL
    `);

    let knowledgeCount = 0;
    try {
      const kc = await query(`SELECT COUNT(*) AS c FROM rag_knowledge_entries WHERE status = 'active'`);
      knowledgeCount = Number(kc[0]?.c || 0);
    } catch {}

    let qualityAvg: Record<string, unknown>[] = [];
    try {
      qualityAvg = await query(`
        SELECT rag_system,
               AVG(score_specificity) AS avg_specificity,
               AVG(score_accuracy) AS avg_accuracy,
               AVG(score_actionability) AS avg_actionability,
               AVG(score_consistency) AS avg_consistency,
               COUNT(*) AS total_runs
        FROM rag_quality_runs WHERE score_specificity IS NOT NULL GROUP BY rag_system
      `);
    } catch {}

    const apiUsage = await query(`
      SELECT endpoint, COUNT(*) AS calls,
             COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') AS calls_30d
      FROM api_usage GROUP BY endpoint
    `);

    if (section === "applications") {
      return NextResponse.json({
        applications: {
          report_stats: stats[0],
          vision_stats: visionStats[0],
          knowledge_entries: knowledgeCount,
          quality_scores: qualityAvg,
          api_usage: apiUsage,
        },
      });
    }
  }

  // ─── Daily Check: 10 random items from across the system to verify ──
  if (section === "daily_check") {
    const items: Record<string, unknown>[] = [];

    // 2-3 vision findings with photos
    const visionItems = await query(`
      SELECT pi.id AS image_id, pi.image_url, pi.property_id, pi.analysed_at AS created_at,
             f->>'category' AS category, f->>'severity' AS severity,
             f->>'observation' AS observation,
             p.address_raw, p.suburb, p.city
      FROM property_images pi
      JOIN properties p ON p.id = pi.property_id,
      jsonb_array_elements(CASE WHEN jsonb_typeof(pi.vision_analysis->'findings') = 'array' THEN pi.vision_analysis->'findings' ELSE '[]'::jsonb END) AS f
      WHERE pi.vision_analysis IS NOT NULL AND f->>'observation' IS NOT NULL
      ORDER BY random() LIMIT 3
    `);
    for (const v of visionItems) {
      items.push({ type: "vision_finding", ...v });
    }

    const reportItems = await query(`
      SELECT pr.id, pr.property_id, pr.decision, pr.decision_reasoning, pr.asking_price,
             pr.avm_low, pr.avm_high, pr.created_at,
             p.address_raw, p.suburb, p.city
      FROM property_reports pr JOIN properties p ON p.id = pr.property_id
      WHERE pr.status = 'complete' AND pr.decision_reasoning IS NOT NULL
      ORDER BY random() LIMIT 3
    `);
    for (const r of reportItems) {
      items.push({ type: "report_decision", ...r });
    }

    const kbItems = await query(`SELECT id, name, description, category, severity, cost_min_zar, cost_max_zar, sa_context, status, created_at FROM rag_knowledge_entries ORDER BY random() LIMIT 2`).catch(() => []);
    for (const k of kbItems) {
      items.push({ type: "knowledge_entry", ...k });
    }

    const evidenceItems = await query(`
      SELECT he.id, he.property_id, he.observation, he.category, he.severity, he.confidence_tier,
             he.tier_reason, he.output_language, he.limitations, he.image_url, he.created_at,
             p.address_raw, p.suburb
      FROM holly_evidence he JOIN properties p ON p.id = he.property_id
      ORDER BY random() LIMIT 2
    `).catch(() => []);
    for (const h of evidenceItems) {
      items.push({ type: "nico_evidence", ...h });
    }

    // Shuffle and take 10
    const shuffled = items.sort(() => Math.random() - 0.5).slice(0, 10);
    return NextResponse.json({ daily_check: shuffled });
  }

  // ─── Data Sources: every data element and its RAG status ────────────
  if (section === "data_sources") {
    const [propCoverage, areaCounts, imageCounts, otherCounts] = await Promise.all([
      query(`SELECT
        COUNT(*) as total, COUNT(lat) as geocoded, COUNT(construction_era) as with_era,
        COUNT(roof_material) as with_roof, COUNT(suburb_crime_score) as with_crime_score,
        COUNT(solar_ghi_kwh_year) as with_solar, COUNT(water_quality_score) as with_water,
        COUNT(gvr_source) as with_gvr, COUNT(description) as with_description,
        COUNT(asking_price) as with_price, COUNT(bedrooms) as with_bedrooms
      FROM properties`),
      query(`SELECT risk_type, COUNT(DISTINCT (suburb || '|' || city)) as suburbs FROM area_risk_data GROUP BY risk_type`),
      query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE vision_analysis IS NOT NULL) as analysed FROM property_images`),
      Promise.all([
        query(`SELECT COUNT(DISTINCT property_id) as c FROM deeds_data`).then(r => r[0]?.c || 0),
        query(`SELECT COUNT(*) as c FROM crime_incidents`).then(r => r[0]?.c || 0),
        query(`SELECT COUNT(*) as c FROM saps_precincts`).catch(() => [{ c: 0 }]).then(r => r[0]?.c || 0),
        query(`SELECT COUNT(*) as c FROM security_companies`).catch(() => [{ c: 0 }]).then(r => r[0]?.c || 0),
        query(`SELECT COUNT(*) as c FROM property_reports WHERE status = 'complete'`).then(r => r[0]?.c || 0),
        query(`SELECT COUNT(*) as c FROM holly_evidence`).catch(() => [{ c: 0 }]).then(r => r[0]?.c || 0),
        query(`SELECT COUNT(*) as c FROM rag_knowledge_entries WHERE status = 'active'`).catch(() => [{ c: 0 }]).then(r => r[0]?.c || 0),
        query(`SELECT COUNT(*) as c FROM data_feedback`).catch(() => [{ c: 0 }]).then(r => r[0]?.c || 0),
      ]),
    ]);

    const areaMap: Record<string, number> = {};
    for (const r of areaCounts) areaMap[r.risk_type] = Number(r.suburbs);
    const [deeds, crimes, precincts, securityCos, reports, evidence, kbActive, feedback] = otherCounts;
    const p = propCoverage[0];
    const img = imageCounts[0];

    return NextResponse.json({ data_sources: [
      { name: "Properties", count: p.total, in_rag: true, detail: "Base property records" },
      { name: "Listings (description)", count: p.with_description, in_rag: true, detail: "Property descriptions from portals" },
      { name: "Prices", count: p.with_price, in_rag: true, detail: "Asking prices from listings" },
      { name: "Geocoded", count: p.geocoded, in_rag: true, detail: "Lat/lng — enables all location-based data" },
      { name: "Photos (total)", count: img.total, in_rag: false, detail: "Raw photos from listings" },
      { name: "Photos (analysed)", count: img.analysed, in_rag: true, detail: "Vision analysis completed" },
      { name: "Vision evidence", count: evidence, in_rag: true, detail: "Structured WHY chain per finding" },
      { name: "Reports", count: reports, in_rag: true, detail: "Complete property reports with decisions" },
      { name: "Knowledge base", count: kbActive, in_rag: true, detail: "Active entries in Nico's prompt" },
      { name: "Deeds", count: deeds, in_rag: true, detail: "Ownership and municipal values" },
      { name: "Construction era", count: p.with_era, in_rag: true, detail: "Building age — drives risk matrix" },
      { name: "Roof material", count: p.with_roof, in_rag: true, detail: "Identified from vision analysis" },
      { name: "Crime incidents", count: crimes, in_rag: true, detail: "SAPS data from CrimeHub" },
      { name: "Crime by suburb", count: p.with_crime_score, in_rag: true, detail: "Properties with crime scores" },
      { name: "Crime detailed", count: areaMap.crime_detailed || 0, in_rag: true, detail: "Suburbs with full crime breakdown" },
      { name: "Security coverage", count: areaMap.security_community || 0, in_rag: true, detail: "Armed response + CPF + NHW" },
      { name: "Security companies", count: securityCos, in_rag: false, detail: "Company records (feeds coverage)" },
      { name: "SAPS precincts", count: precincts, in_rag: false, detail: "Police station records" },
      { name: "Solar data", count: p.with_solar, in_rag: true, detail: "PVGIS irradiance measurements" },
      { name: "Water quality", count: p.with_water, in_rag: true, detail: "DWS Blue/Green Drop scores" },
      { name: "Water detailed", count: areaMap.water_quality || 0, in_rag: true, detail: "Suburbs with water data" },
      { name: "GVR municipal", count: p.with_gvr, in_rag: true, detail: "Valuation roll data" },
      { name: "Dolomite risk", count: areaMap.dolomite || 0, in_rag: true, detail: "Geological risk areas" },
      { name: "Social concerns", count: areaMap.social_concerns || 0, in_rag: false, detail: "Google Places review sentiment" },
      { name: "Schools", count: areaMap.school_proximity || 0, in_rag: true, detail: "School proximity scores" },
      { name: "Climate", count: areaMap.climate || 0, in_rag: true, detail: "Rainfall, humidity, damp risk" },
      { name: "Load shedding", count: areaMap.loadshedding || 0, in_rag: false, detail: "Schedule data (when available)" },
      { name: "Sold prices", count: areaMap.sold_prices || 0, in_rag: true, detail: "Suburb sale price history" },
      { name: "Fibre coverage", count: areaMap.fibre_coverage || 0, in_rag: false, detail: "ISP availability" },
      { name: "Sewerage quality", count: areaMap.sewerage_quality || 0, in_rag: true, detail: "DWS Green Drop scores" },
      { name: "User feedback", count: feedback, in_rag: true, detail: "Your corrections and confirmations" },
    ]});
  }

  // ─── Prompts: show all the prompts Nico uses ───────────────────────
  if (section === "prompts") {
    // Read prompts from the actual source files
    const fs = await import("fs");
    const path = await import("path");
    const projectDir = path.default.resolve(process.cwd(), "..");

    const prompts: Record<string, string>[] = [];
    try {
      const visionJs = fs.default.readFileSync(path.default.join(projectDir, "vision.js"), "utf8");
      const nicoVisionMatch = visionJs.match(/const NICO_SYSTEM_PROMPT = `([\s\S]*?)`;/);
      if (nicoVisionMatch) prompts.push({ name: "Nico — Vision Analysis", source: "vision.js", prompt: nicoVisionMatch[1].substring(0, 3000) });
    } catch {}
    try {
      const synthJs = fs.default.readFileSync(path.default.join(projectDir, "synthesis.js"), "utf8");
      const synthMatch = synthJs.match(/const SYNTHESIS_SYSTEM_PROMPT = `([\s\S]*?)`;/);
      if (synthMatch) prompts.push({ name: "Report Synthesis", source: "synthesis.js", prompt: synthMatch[1].substring(0, 3000) });
    } catch {}

    return NextResponse.json({ prompts });
  }

  return NextResponse.json({ ok: true, message: "Use ?section= param for specific data" });
});

// ─── POST: Knowledge base CRUD and quality run creation ───────────────
export const POST = withAuth(async (req: NextRequest) => {
  const body = await req.json();
  const { action } = body;

  if (action === "save_knowledge") {
    const { id, name, description, visual_indicators, sa_context, severity, cost_min_zar, cost_max_zar, category, status, image_id, image_url, property_id, original_finding } = body;
    if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });

    if (id) {
      await query(
        `UPDATE rag_knowledge_entries SET name=$1, description=$2, visual_indicators=$3, sa_context=$4,
           severity=$5, cost_min_zar=$6, cost_max_zar=$7, category=$8, status=$9,
           image_id=$10, image_url=$11, property_id=$12, original_finding=$13, updated_at=NOW() WHERE id=$14`,
        [name, description, visual_indicators, sa_context, severity, cost_min_zar, cost_max_zar, category, status || 'draft',
         image_id || null, image_url || null, property_id || null, original_finding ? JSON.stringify(original_finding) : null, id]
      );
      return NextResponse.json({ ok: true, id });
    } else {
      const rows = await query(
        `INSERT INTO rag_knowledge_entries (name, description, visual_indicators, sa_context, severity, cost_min_zar, cost_max_zar, category, status, image_id, image_url, property_id, original_finding)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [name, description, visual_indicators, sa_context, severity, cost_min_zar, cost_max_zar, category, status || 'draft',
         image_id || null, image_url || null, property_id || null, original_finding ? JSON.stringify(original_finding) : null]
      );
      return NextResponse.json({ ok: true, id: rows[0].id });
    }
  }

  if (action === "toggle_knowledge") {
    const { id } = body;
    await query(
      `UPDATE rag_knowledge_entries SET status = CASE WHEN status='active' THEN 'draft' ELSE 'active' END, updated_at=NOW() WHERE id=$1`,
      [id]
    );
    return NextResponse.json({ ok: true });
  }

  // ─── Daily Check: confirm or reject an item ─────────────────────────
  if (action === "confirm_check") {
    const { item_type, item_id, verdict, reason, property_id } = body;
    // verdict: "correct" | "incorrect" | "unsure"
    await query(
      `INSERT INTO data_feedback (property_id, section, field_name, feedback, rating, page_url)
       VALUES ($1, $2, $3, $4, $5, '/admin/intelligence')`,
      [property_id || null, `daily_check:${item_type}`, item_id ? String(item_id) : null, reason || verdict, verdict]
    );
    // If it's a KB entry marked incorrect, flag it
    if (item_type === "knowledge_entry" && verdict === "incorrect" && item_id) {
      await query("UPDATE rag_knowledge_entries SET status = 'draft', updated_at = NOW() WHERE id = $1", [item_id]);
    }
    return NextResponse.json({ ok: true });
  }

  if (action === "save_quality_run") {
    const { run_type, rag_system, query_text, image_url, property_id, rag_context,
            response_without_rag, response_with_rag,
            score_specificity, score_accuracy, score_actionability, score_consistency, notes } = body;
    const rows = await query(
      `INSERT INTO rag_quality_runs (run_type, rag_system, query_text, image_url, property_id, rag_context,
        response_without_rag, response_with_rag, score_specificity, score_accuracy, score_actionability, score_consistency, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [run_type, rag_system, query_text, image_url, property_id,
       rag_context ? JSON.stringify(rag_context) : null,
       response_without_rag, response_with_rag,
       score_specificity, score_accuracy, score_actionability, score_consistency, notes]
    );
    return NextResponse.json({ ok: true, id: rows[0].id });
  }

  if (action === "run_comparison") {
    const { image_base64, image_media_type } = body;
    if (!image_base64) return NextResponse.json({ error: "image_base64 required — upload a photo" }, { status: 400 });

    // Load the base vision prompt (same one vision.js uses)
    const basePrompt = `You are a certified property inspector with 20 years of South African experience.
Analyse this property photo. Identify every visible risk, defect, or flag that would concern a buyer, an insurer, or a trades professional.
Return structured JSON:
{
  "photo_type": "exterior|interior|roof|bathroom|kitchen|db_board|ceiling|other",
  "findings": [{"category": "roof|walls|damp|electrical|plumbing|ceiling|structure|extension", "observation": "exact description", "confidence": "CONFIRMED_VISIBLE|PROBABLE|POSSIBLE", "severity": "CRITICAL|HIGH|MEDIUM|LOW|COSMETIC", "estimated_repair_cost_zar": {"min": 0, "max": 0}}],
  "roof_material": "corrugated_cement|IBR|concrete_tile|clay_tile|other|unknown",
  "solar_installed": false,
  "asbestos_indicators": false,
  "security_visible": false
}
Rules: Never confirm asbestos — flag indicators only. SA terminology. ZAR costs. Return ONLY valid JSON.`;

    // Build RAG-enhanced prompt with active KB entries
    let ragPrompt = basePrompt;
    let kbCount = 0;
    try {
      const kbRows = await query(
        "SELECT name, category, description, visual_indicators, sa_context, severity, cost_min_zar, cost_max_zar FROM rag_knowledge_entries WHERE status = 'active' ORDER BY severity DESC"
      );
      if (kbRows.length > 0) {
        kbCount = kbRows.length;
        const entries = kbRows.map((e: Record<string, unknown>) =>
          `- ${e.name} [${e.category}, severity ${e.severity}/5${e.cost_min_zar ? `, R${e.cost_min_zar}–R${e.cost_max_zar}` : ''}]: ${e.description || ''}${e.visual_indicators ? ` LOOK FOR: ${e.visual_indicators}` : ''}${e.sa_context ? ` SA CONTEXT: ${e.sa_context}` : ''}`
        ).join('\n');
        ragPrompt += `\n\nSA DEFECT KNOWLEDGE BASE (${kbRows.length} entries — use these to identify region-specific defects and calibrate severity/cost estimates):\n${entries}`;
      }
    } catch {}

    const imageContent = {
      type: "image" as const,
      source: { type: "base64" as const, media_type: (image_media_type || "image/jpeg") as "image/jpeg" | "image/png" | "image/gif" | "image/webp", data: image_base64 },
    };

    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const claude = new Anthropic();

    // Run both in parallel — same image, same model, different prompts
    const [withoutRag, withRag] = await Promise.all([
      claude.messages.create({
        model: "claude-3-haiku-20240307",
        max_tokens: 2048,
        system: basePrompt,
        messages: [{ role: "user", content: [imageContent, { type: "text", text: "Analyse this property photo." }] }],
      }),
      claude.messages.create({
        model: "claude-3-haiku-20240307",
        max_tokens: 2048,
        system: ragPrompt,
        messages: [{ role: "user", content: [imageContent, { type: "text", text: "Analyse this property photo." }] }],
      }),
    ]);

    const responseWithout = withoutRag.content[0].type === "text" ? withoutRag.content[0].text : "";
    const responseWith = withRag.content[0].type === "text" ? withRag.content[0].text : "";

    return NextResponse.json({
      ok: true,
      response_without_rag: responseWithout,
      response_with_rag: responseWith,
      kb_entries_used: kbCount,
    });
  }

  // ─── AI Agent: auto-review findings and build KB entries ─────────────
  if (action === "run_kb_agent") {
    // Get all findings with their photos, excluding ones already in KB
    const existingObs = await query("SELECT description FROM rag_knowledge_entries");
    const existingSet = new Set(existingObs.map((r: Record<string, unknown>) => (r.description as string || "").substring(0, 80)));

    const photos = await query(`
      SELECT pi.id AS image_id, pi.property_id, pi.image_url, pi.image_type,
             pi.vision_analysis->'findings' AS findings,
             pi.vision_analysis->>'photo_type' AS photo_type,
             p.address_raw, p.suburb, p.city, p.construction_era
      FROM property_images pi
      JOIN properties p ON p.id = pi.property_id
      WHERE pi.vision_analysis IS NOT NULL
        AND jsonb_typeof(pi.vision_analysis->'findings') = 'array'
        AND jsonb_array_length(pi.vision_analysis->'findings') > 0
      ORDER BY pi.analysed_at DESC NULLS LAST
      LIMIT 100
    `);

    // Flatten all findings with their photo context
    const candidates: { finding: Record<string, unknown>; photo: Record<string, unknown> }[] = [];
    for (const photo of photos) {
      const findings = photo.findings || [];
      for (const f of findings) {
        // Skip cosmetic/low findings and ones already in KB
        if (f.severity === "COSMETIC") continue;
        if (f.observation && existingSet.has(f.observation.substring(0, 80))) continue;
        // Skip generic "good condition" observations
        if (f.observation && /good condition|no visible|appears? (to be )?in good|well.maintained/i.test(f.observation)) continue;
        candidates.push({ finding: f, photo });
      }
    }

    if (candidates.length === 0) {
      return NextResponse.json({ ok: true, message: "No new findings to review", created: 0 });
    }

    // Send candidates to Claude for KB evaluation — batch of up to 30
    const batch = candidates.slice(0, 30);
    const findingsText = batch.map((c, i) =>
      `[${i}] Category: ${c.finding.category} | Severity: ${c.finding.severity} | Observation: ${c.finding.observation} | Photo: ${c.photo.photo_type || c.photo.image_type} | Property: ${c.photo.address_raw}, ${c.photo.suburb} | Cost: R${(c.finding.estimated_repair_cost_zar as Record<string, number>)?.min || '?'}–R${(c.finding.estimated_repair_cost_zar as Record<string, number>)?.max || '?'}`
    ).join('\n');

    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const claude = new Anthropic();

    const evaluation = await claude.messages.create({
      model: "claude-3-haiku-20240307",
      max_tokens: 4096,
      system: `You are a South African property defect expert reviewing vision analysis findings to build a knowledge base for improving future property inspections.

Select findings that would make good knowledge base entries — things that teach the vision system about SA-specific defects, materials, costs, and regional patterns.

GOOD entries: real defects (cracks, damp, asbestos indicators, electrical issues, plumbing problems), SA-specific materials, region-specific patterns (Cape Town damp, Joburg dolomite), things with actual cost implications.

BAD entries: generic observations ("walls in good condition"), cosmetic notes, vague structural comments, vegetation observations, interior decor descriptions.

For each finding you select, return a JSON array of objects:
[{
  "index": 0,
  "name": "Short defect name (e.g. 'Efflorescence — Cape Town face brick')",
  "visual_indicators": "What to look for in similar photos",
  "sa_context": "Why this matters in South Africa — regional context, local costs, common causes",
  "severity": 1-5,
  "cost_min_zar": number or null,
  "cost_max_zar": number or null
}]

Only select findings worth teaching the system about. It's better to select 3 good ones than 15 mediocre ones. Return ONLY valid JSON array.`,
      messages: [{ role: "user", content: `Review these ${batch.length} findings and select the ones worth adding to the SA property defect knowledge base:\n\n${findingsText}` }],
    });

    // Parse Claude's selections
    let selections: { index: number; name: string; visual_indicators: string; sa_context: string; severity: number; cost_min_zar: number | null; cost_max_zar: number | null }[] = [];
    try {
      let text = evaluation.content[0].type === "text" ? evaluation.content[0].text.trim() : "[]";
      if (text.includes("```")) text = text.replace(/```(?:json)?\s*/g, "").replace(/```/g, "");
      const jStart = text.indexOf("[");
      const jEnd = text.lastIndexOf("]");
      if (jStart >= 0 && jEnd > jStart) text = text.substring(jStart, jEnd + 1);
      selections = JSON.parse(text);
    } catch {
      return NextResponse.json({ ok: false, message: "Agent returned unparseable response", created: 0 });
    }

    // Create KB entries for selected findings
    let created = 0;
    for (const sel of selections) {
      const c = batch[sel.index];
      if (!c) continue;

      await query(
        `INSERT INTO rag_knowledge_entries (name, description, visual_indicators, sa_context, severity, cost_min_zar, cost_max_zar, category, status, image_id, image_url, property_id, original_finding)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'draft',$9,$10,$11,$12)`,
        [
          sel.name,
          c.finding.observation,
          sel.visual_indicators,
          sel.sa_context,
          sel.severity,
          sel.cost_min_zar || (c.finding.estimated_repair_cost_zar as Record<string, number>)?.min || null,
          sel.cost_max_zar || (c.finding.estimated_repair_cost_zar as Record<string, number>)?.max || null,
          c.finding.category,
          c.photo.image_id,
          c.photo.image_url,
          c.photo.property_id,
          JSON.stringify(c.finding),
        ]
      );
      created++;
    }

    return NextResponse.json({
      ok: true,
      message: `Agent reviewed ${batch.length} findings, created ${created} draft KB entries`,
      reviewed: batch.length,
      created,
    });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
});
