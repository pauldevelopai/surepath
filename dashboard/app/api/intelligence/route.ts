import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { withAuth } from "@/lib/auth";
import * as fs from "fs";
import * as path from "path";

// ─── RAG Intelligence Test Helpers ───────────────────────────────────────

// SA-specific terms that indicate the RAG is contributing domain knowledge
const SA_TERMS = [
  "ECoC", "SANS 10142", "SANS 10400", "DPC", "damp-proof course", "DPC injection",
  "body corporate", "sectional title", "municipal value", "title deed",
  "efflorescence", "galvanised", "asbestos", "corrugated cement",
  "dolomite", "Eskom", "geyser", "prepaid meter", "earth leakage",
  "rewirable fuse", "IBR", "face brick", "plaster skim",
];

// Read the real Nico v3 system prompt from vision.js (without KB entries)
async function _readNicoBasePrompt(): Promise<string> {
  try {
    const visionPath = path.resolve(process.cwd(), "..", "vision.js");
    const src = fs.readFileSync(visionPath, "utf-8");
    // Extract the NICO_SYSTEM_PROMPT constant
    const match = src.match(/const NICO_SYSTEM_PROMPT = `([\s\S]*?)`;/);
    if (match) return match[1];
  } catch {}
  // Fallback — the core Nico v3 prompt inline (kept in sync manually)
  return `You are Nico. Former estate agent, 20 years in the South African property market. You have walked through thousands of properties across the country. When you look at a photo, you are not describing what you see — you are assessing what it means for the buyer.

HOW YOU THINK

For every issue you identify in a photo, you must distinguish three things that are never conflated:
  1. WHAT YOU CAN SEE — the specific visual evidence in this photo
  2. WHAT YOU CAN INFER — what the visual evidence means when combined with property data and your knowledge
  3. WHAT REQUIRES PHYSICAL INSPECTION — what you cannot determine from a photo alone

WHAT YOU RETURN

For each photo, return a JSON object. Every finding MUST contain ALL of these fields or it will be rejected:

{
  "photo_type": "exterior|interior|roof|bathroom|kitchen|db_board|ceiling|other",
  "findings": [{
    "what_i_see": "Exact visual evidence. Where in the photo. What is physically visible.",
    "visual_location": "Where in the photo",
    "category": "roof|walls|damp|electrical|plumbing|ceiling|structure|extension|security|environment",
    "defect_or_risk": "What defect or risk this maps to",
    "kb_entry_matched": null,
    "kb_match_reason": null,
    "sa_context": "What SA-specific context is relevant",
    "corroboration": { "supporting": null, "contradicting": null, "data_used": [] },
    "confidence_tier": 1,
    "tier_reason": "Visual only — no KB or property data available for this test",
    "severity": "CRITICAL|HIGH|MEDIUM|LOW|COSMETIC",
    "estimated_repair_cost_zar": {"min": 0, "max": 0},
    "cost_source": "nico_estimate",
    "what_it_means": "Plain language for buyer",
    "needs_inspection": "What physical inspection would reveal",
    "relevant_to": ["consumer"]
  }],
  "roof_material": "corrugated_cement|IBR|concrete_tile|clay_tile|other|unknown",
  "solar_installed": false,
  "asbestos_indicators": false,
  "security_visible": false
}

RULES
- Use SA property terminology and ZAR costs at SA labour rates
- Never confirm asbestos — flag indicators only
- If you find nothing wrong, say so clearly
- Return ONLY valid JSON`;
}

interface RagSignals {
  // KB reference signals
  kb_entries_referenced: string[];
  kb_references_baseline: string[];
  kb_lift: number; // how many MORE kb references in RAG vs baseline

  // SA domain knowledge signals
  sa_terms_rag: string[];
  sa_terms_baseline: string[];
  sa_term_lift: number;

  // Cost accuracy signals
  uses_zar_rag: boolean;
  uses_zar_baseline: boolean;
  has_cost_ranges_rag: boolean;
  has_cost_ranges_baseline: boolean;

  // Structural quality
  findings_count_rag: number;
  findings_count_baseline: number;
  has_confidence_tiers_rag: boolean;
  has_confidence_tiers_baseline: boolean;
  has_why_chain_rag: boolean;
  has_why_chain_baseline: boolean;

  // Overall RAG contribution score (0-100)
  rag_contribution_score: number;
}

function _detectRagSignals(baseline: string, ragResponse: string, kbNames: string[]): RagSignals {
  const lower = (s: string) => s.toLowerCase();
  const baseL = lower(baseline);
  const ragL = lower(ragResponse);

  // KB entry references
  const kb_entries_referenced = kbNames.filter(n => ragL.includes(lower(n)));
  const kb_references_baseline = kbNames.filter(n => baseL.includes(lower(n)));

  // SA terms
  const sa_terms_rag = SA_TERMS.filter(t => ragL.includes(lower(t)));
  const sa_terms_baseline = SA_TERMS.filter(t => baseL.includes(lower(t)));

  // Cost signals
  const zarPattern = /R\s?\d[\d\s,]*(?:–|-)R?\s?\d[\d\s,]*/g;
  const uses_zar_rag = /\bR\s?\d/.test(ragResponse) || /\bzar\b/i.test(ragResponse);
  const uses_zar_baseline = /\bR\s?\d/.test(baseline) || /\bzar\b/i.test(baseline);
  const has_cost_ranges_rag = zarPattern.test(ragResponse) || /"min"\s*:\s*\d+.*"max"\s*:\s*\d+/.test(ragResponse);
  const has_cost_ranges_baseline = /R\s?\d[\d\s,]*(?:–|-)R?\s?\d[\d\s,]*/g.test(baseline) || /"min"\s*:\s*\d+.*"max"\s*:\s*\d+/.test(baseline);

  // Count findings
  const countFindings = (s: string) => {
    try {
      const json = JSON.parse(s.replace(/```json?\s*/g, "").replace(/```/g, "").trim());
      return Array.isArray(json.findings) ? json.findings.length : 0;
    } catch { return (s.match(/"what_i_see"|"observation"/g) || []).length; }
  };

  const findings_count_rag = countFindings(ragResponse);
  const findings_count_baseline = countFindings(baseline);

  // Confidence tiers (Nico v3 feature)
  const has_confidence_tiers_rag = /confidence_tier.*[1-4]/.test(ragResponse);
  const has_confidence_tiers_baseline = /confidence_tier.*[1-4]/.test(baseline);

  // WHY chain (what_i_see + what_it_means + needs_inspection)
  const hasWhyChain = (s: string) => /what_i_see/.test(s) && /what_it_means/.test(s) && /needs_inspection/.test(s);
  const has_why_chain_rag = hasWhyChain(ragResponse);
  const has_why_chain_baseline = hasWhyChain(baseline);

  // Compute RAG contribution score (0-100)
  let score = 0;
  const kb_lift = kb_entries_referenced.length - kb_references_baseline.length;
  const sa_term_lift = sa_terms_rag.length - sa_terms_baseline.length;

  // KB references from RAG (biggest signal — 0-30 points)
  score += Math.min(kb_entries_referenced.length * 10, 30);
  // SA term lift (0-20 points)
  score += Math.min(Math.max(sa_term_lift, 0) * 4, 20);
  // Uses ZAR in RAG (5 points)
  if (uses_zar_rag) score += 5;
  // Has cost ranges in RAG (10 points)
  if (has_cost_ranges_rag) score += 10;
  // Confidence tiers in RAG (10 points)
  if (has_confidence_tiers_rag) score += 10;
  // WHY chain in RAG (10 points)
  if (has_why_chain_rag) score += 10;
  // More findings in RAG vs baseline (0-15 points)
  if (findings_count_rag > findings_count_baseline) score += Math.min((findings_count_rag - findings_count_baseline) * 5, 15);

  return {
    kb_entries_referenced, kb_references_baseline, kb_lift,
    sa_terms_rag, sa_terms_baseline, sa_term_lift,
    uses_zar_rag, uses_zar_baseline, has_cost_ranges_rag, has_cost_ranges_baseline,
    findings_count_rag, findings_count_baseline,
    has_confidence_tiers_rag, has_confidence_tiers_baseline,
    has_why_chain_rag, has_why_chain_baseline,
    rag_contribution_score: Math.min(score, 100),
  };
}

function _aggregateSignals(signals: RagSignals[]) {
  if (signals.length === 0) return null;
  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const pct = (arr: boolean[]) => Math.round(arr.filter(Boolean).length / arr.length * 100);

  return {
    avg_rag_contribution_score: Math.round(avg(signals.map(s => s.rag_contribution_score))),
    avg_kb_lift: Number(avg(signals.map(s => s.kb_lift)).toFixed(1)),
    avg_sa_term_lift: Number(avg(signals.map(s => s.sa_term_lift)).toFixed(1)),
    avg_findings_rag: Number(avg(signals.map(s => s.findings_count_rag)).toFixed(1)),
    avg_findings_baseline: Number(avg(signals.map(s => s.findings_count_baseline)).toFixed(1)),
    pct_uses_zar: pct(signals.map(s => s.uses_zar_rag)),
    pct_has_cost_ranges: pct(signals.map(s => s.has_cost_ranges_rag)),
    pct_has_confidence_tiers: pct(signals.map(s => s.has_confidence_tiers_rag)),
    pct_has_why_chain: pct(signals.map(s => s.has_why_chain_rag)),
    photos_tested: signals.length,
  };
}

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

    const feedbackStats = await query(`
      SELECT COUNT(*) AS total,
        COUNT(*) FILTER (WHERE rating IN ('correct', 'good')) AS positive,
        COUNT(*) FILTER (WHERE rating IN ('incorrect', 'bad')) AS negative,
        COUNT(*) FILTER (WHERE rating = 'unsure') AS unsure
      FROM data_feedback
    `).catch(() => [{ total: 0, positive: 0, negative: 0, unsure: 0 }]);

    const summary = {
      reports: reportStats[0],
      images: imageStats[0],
      properties: propertyStats[0],
      deeds_coverage: Number(deedsStats[0]?.c || 0),
      crime: crimeStats[0],
      knowledge_base: kbStats[0] || { total: 0, active: 0 },
      quality: qualityStats[0] || { runs: 0, avg_score: null },
      feedback: feedbackStats[0] || { total: 0, positive: 0, negative: 0, unsure: 0 },
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

  // ─── Properties for test selector ──────────────────────────────────
  if (section === "properties_for_test") {
    const props = await query(`
      SELECT id, address_raw, suburb, city, construction_era
      FROM properties
      WHERE suburb IS NOT NULL
      ORDER BY created_at DESC LIMIT 100
    `);
    return NextResponse.json({ properties: props });
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
      { name: "Properties", count: p.total, in_rag: true, detail: "Base property records", type: "properties" },
      { name: "Listings (description)", count: p.with_description, in_rag: true, detail: "Property descriptions from portals", type: "listings" },
      { name: "Prices", count: p.with_price, in_rag: true, detail: "Asking prices from listings", type: "prices" },
      { name: "Geocoded", count: p.geocoded, in_rag: true, detail: "Lat/lng — enables all location-based data", type: "geocoded" },
      { name: "Photos (total)", count: img.total, in_rag: false, detail: "Raw photos from listings", type: "photos" },
      { name: "Photos (analysed)", count: img.analysed, in_rag: true, detail: "Vision analysis completed", type: "photos_analysed" },
      { name: "Vision evidence", count: evidence, in_rag: true, detail: "Structured WHY chain per finding", type: "evidence" },
      { name: "Reports", count: reports, in_rag: true, detail: "Complete property reports with decisions", type: "reports" },
      { name: "Knowledge base", count: kbActive, in_rag: true, detail: "Active entries in Nico's prompt", type: "kb" },
      { name: "Deeds", count: deeds, in_rag: true, detail: "Ownership and municipal values", type: "deeds" },
      { name: "Construction era", count: p.with_era, in_rag: true, detail: "Building age — drives risk matrix", type: "construction_era" },
      { name: "Roof material", count: p.with_roof, in_rag: true, detail: "Identified from vision analysis", type: "roof_material" },
      { name: "Crime incidents", count: crimes, in_rag: true, detail: "SAPS data from CrimeHub", type: "crime_incidents" },
      { name: "Crime by suburb", count: p.with_crime_score, in_rag: true, detail: "Properties with crime scores", type: "crime_scores" },
      { name: "Crime detailed", count: areaMap.crime_detailed || 0, in_rag: true, detail: "Suburbs with full crime breakdown", type: "crime_detailed" },
      { name: "Security coverage", count: areaMap.security_community || 0, in_rag: true, detail: "Armed response + CPF + NHW", type: "security_community" },
      { name: "Security companies", count: securityCos, in_rag: false, detail: "Company records (feeds coverage)", type: "security_companies" },
      { name: "SAPS precincts", count: precincts, in_rag: false, detail: "Police station records", type: "saps" },
      { name: "Solar data", count: p.with_solar, in_rag: true, detail: "PVGIS irradiance measurements", type: "solar" },
      { name: "Water quality", count: p.with_water, in_rag: true, detail: "DWS Blue/Green Drop scores", type: "water_quality" },
      { name: "Water detailed", count: areaMap.water_quality || 0, in_rag: true, detail: "Suburbs with water data", type: "water_detailed" },
      { name: "GVR municipal", count: p.with_gvr, in_rag: true, detail: "Valuation roll data", type: "gvr" },
      { name: "Dolomite risk", count: areaMap.dolomite || 0, in_rag: true, detail: "Geological risk areas", type: "dolomite" },
      { name: "Social concerns", count: areaMap.social_concerns || 0, in_rag: false, detail: "Google Places review sentiment", type: "social_concerns" },
      { name: "Schools", count: areaMap.school_proximity || 0, in_rag: true, detail: "School proximity scores", type: "school_proximity" },
      { name: "Climate", count: areaMap.climate || 0, in_rag: true, detail: "Rainfall, humidity, damp risk", type: "climate" },
      { name: "Electricity", count: areaMap.electricity || 0, in_rag: true, detail: "Tariff rates and cost estimates", type: "electricity" },
      { name: "Load shedding", count: areaMap.loadshedding || 0, in_rag: false, detail: "Schedule data (when available)", type: "loadshedding" },
      { name: "Sold prices", count: areaMap.sold_prices || 0, in_rag: true, detail: "Suburb sale price history", type: "sold_prices" },
      { name: "Fibre coverage", count: areaMap.fibre_coverage || 0, in_rag: false, detail: "ISP availability", type: "fibre_coverage" },
      { name: "Sewerage quality", count: areaMap.sewerage_quality || 0, in_rag: true, detail: "DWS Green Drop scores", type: "sewerage_quality" },
      { name: "User feedback", count: feedback, in_rag: true, detail: "Your corrections and confirmations", type: "feedback" },
    ]});
  }

  // ─── Data Detail: show actual records for a data source type ────────
  if (section === "data_detail") {
    const type = req.nextUrl.searchParams.get("type");
    const page = Math.max(1, parseInt(req.nextUrl.searchParams.get("page") || "1"));
    const search = req.nextUrl.searchParams.get("search") || "";
    const perPage = 50;
    const offset = (page - 1) * perPage;
    if (!type) return NextResponse.json({ error: "type required" }, { status: 400 });

    let rows: Record<string, unknown>[] = [];
    let columns: string[] = [];
    let totalCount = 0;

    // Search filter for text columns — builds a WHERE clause
    const searchWhere = (cols: string[], paramStart = 1) => {
      if (!search) return { clause: "", params: [] };
      const conditions = cols.map((c, i) => `${c}::text ILIKE $${paramStart + i}`);
      return { clause: `AND (${conditions.join(" OR ")})`, params: cols.map(() => `%${search}%`) };
    };

    // Helper: paginated query with total count
    async function paged(selectSql: string, countSql: string, searchCols: string[], extraParams: unknown[] = []) {
      const s = searchWhere(searchCols, extraParams.length + 1);
      const countResult = await query(`${countSql} ${s.clause}`, [...extraParams, ...s.params]).catch(() => [{ c: 0 }]);
      totalCount = Number(countResult[0]?.c || countResult[0]?.count || 0);
      rows = await query(`${selectSql} ${s.clause} ORDER BY 1 DESC LIMIT ${perPage} OFFSET ${offset}`, [...extraParams, ...s.params]);
      return rows;
    }

    try {
      switch (type) {
        case "properties":
          columns = ["id", "address_raw", "suburb", "city", "property_type", "bedrooms", "asking_price", "construction_era"];
          await paged(
            "SELECT id, address_raw, suburb, city, province, property_type, bedrooms, bathrooms, asking_price, construction_era FROM properties WHERE true",
            "SELECT COUNT(*) AS c FROM properties WHERE true",
            ["address_raw", "suburb", "city"]
          );
          break;
        case "listings":
          columns = ["id", "address_raw", "suburb", "description"];
          await paged(
            "SELECT id, address_raw, suburb, city, substring(description, 1, 120) AS description FROM properties WHERE description IS NOT NULL",
            "SELECT COUNT(*) AS c FROM properties WHERE description IS NOT NULL",
            ["address_raw", "suburb", "description"]
          );
          break;
        case "prices":
          columns = ["id", "address_raw", "suburb", "asking_price", "levies", "rates_and_taxes"];
          await paged(
            "SELECT id, address_raw, suburb, city, asking_price, levies, rates_and_taxes FROM properties WHERE asking_price IS NOT NULL",
            "SELECT COUNT(*) AS c FROM properties WHERE asking_price IS NOT NULL",
            ["address_raw", "suburb", "city"]
          );
          break;
        case "geocoded":
          columns = ["id", "address_raw", "suburb", "lat", "lng"];
          await paged(
            "SELECT id, address_raw, suburb, city, lat, lng FROM properties WHERE lat IS NOT NULL",
            "SELECT COUNT(*) AS c FROM properties WHERE lat IS NOT NULL",
            ["address_raw", "suburb"]
          );
          break;
        case "photos":
          columns = ["id", "property_id", "image_type", "address_raw", "suburb"];
          await paged(
            "SELECT pi.id, pi.property_id, pi.image_type, pi.image_url, p.address_raw, p.suburb FROM property_images pi JOIN properties p ON p.id = pi.property_id WHERE true",
            "SELECT COUNT(*) AS c FROM property_images WHERE true",
            ["p.address_raw", "p.suburb", "pi.image_type"]
          );
          break;
        case "photos_analysed":
          columns = ["id", "property_id", "photo_type", "findings_count", "address_raw", "suburb"];
          await paged(
            "SELECT pi.id, pi.property_id, pi.image_type, pi.vision_analysis->>'photo_type' AS photo_type, jsonb_array_length(CASE WHEN jsonb_typeof(pi.vision_analysis->'findings') = 'array' THEN pi.vision_analysis->'findings' ELSE '[]'::jsonb END) AS findings_count, p.address_raw, p.suburb FROM property_images pi JOIN properties p ON p.id = pi.property_id WHERE pi.vision_analysis IS NOT NULL",
            "SELECT COUNT(*) AS c FROM property_images WHERE vision_analysis IS NOT NULL",
            ["p.address_raw", "p.suburb"]
          );
          break;
        case "evidence":
          columns = ["id", "category", "severity", "confidence_tier", "what_i_see", "address_raw"];
          await paged(
            "SELECT he.id, he.category, he.severity, he.confidence_tier, he.what_i_see, he.what_it_means, he.cost_min_zar, he.cost_max_zar, p.address_raw, p.suburb FROM holly_evidence he JOIN properties p ON p.id = he.property_id WHERE true",
            "SELECT COUNT(*) AS c FROM holly_evidence WHERE true",
            ["he.category", "p.address_raw"]
          );
          break;
        case "reports":
          columns = ["id", "property_id", "decision", "decision_reasoning", "asking_price", "address_raw", "suburb"];
          await paged(
            "SELECT pr.id, pr.property_id, pr.decision, pr.decision_reasoning, pr.asking_price, pr.avm_low, pr.avm_high, pr.status, pr.created_at, p.address_raw, p.suburb FROM property_reports pr JOIN properties p ON p.id = pr.property_id WHERE true",
            "SELECT COUNT(*) AS c FROM property_reports WHERE true",
            ["p.address_raw", "p.suburb", "pr.decision"]
          );
          break;
        case "kb":
          columns = ["id", "name", "category", "severity", "cost_min_zar", "cost_max_zar", "status"];
          await paged(
            "SELECT id, name, category, severity, cost_min_zar, cost_max_zar, description, visual_indicators, sa_context, status FROM rag_knowledge_entries WHERE true",
            "SELECT COUNT(*) AS c FROM rag_knowledge_entries WHERE true",
            ["name", "category", "sa_context"]
          );
          break;
        case "deeds":
          columns = ["id", "registered_owner", "title_deed_ref", "municipal_value", "address_raw", "source"];
          await paged(
            "SELECT dd.id, dd.property_id, dd.registered_owner, dd.title_deed_ref, dd.municipal_value, dd.source, dd.fetched_at, p.address_raw, p.suburb FROM deeds_data dd JOIN properties p ON p.id = dd.property_id WHERE true",
            "SELECT COUNT(*) AS c FROM deeds_data WHERE true",
            ["dd.registered_owner", "p.address_raw"]
          );
          break;
        case "construction_era":
          columns = ["id", "address_raw", "suburb", "construction_era"];
          await paged(
            "SELECT id, address_raw, suburb, city, construction_era FROM properties WHERE construction_era IS NOT NULL",
            "SELECT COUNT(*) AS c FROM properties WHERE construction_era IS NOT NULL",
            ["address_raw", "suburb", "construction_era"]
          );
          break;
        case "roof_material":
          columns = ["id", "address_raw", "suburb", "roof_material"];
          await paged(
            "SELECT id, address_raw, suburb, roof_material FROM properties WHERE roof_material IS NOT NULL",
            "SELECT COUNT(*) AS c FROM properties WHERE roof_material IS NOT NULL",
            ["address_raw", "suburb", "roof_material"]
          );
          break;
        case "crime_incidents":
          columns = ["suburb", "city", "incident_type", "count"];
          { const s = searchWhere(["suburb", "city", "incident_type"]);
            totalCount = Number((await query(`SELECT COUNT(DISTINCT (suburb || incident_type)) AS c FROM crime_incidents WHERE true ${s.clause}`, s.params))[0]?.c || 0);
            rows = await query(`SELECT suburb, city, incident_type, COUNT(*) AS count FROM crime_incidents WHERE true ${s.clause} GROUP BY suburb, city, incident_type ORDER BY count DESC LIMIT ${perPage} OFFSET ${offset}`, s.params);
          }
          break;
        case "crime_scores":
          columns = ["id", "address_raw", "suburb", "suburb_crime_score"];
          await paged(
            "SELECT id, address_raw, suburb, city, suburb_crime_score FROM properties WHERE suburb_crime_score IS NOT NULL",
            "SELECT COUNT(*) AS c FROM properties WHERE suburb_crime_score IS NOT NULL",
            ["address_raw", "suburb"]
          );
          break;
        case "security_companies":
          columns = ["id", "name", "phone", "google_rating", "province", "armed_response"];
          await paged(
            "SELECT id, name, phone, website, google_rating, google_review_count, province, armed_response FROM security_companies WHERE true",
            "SELECT COUNT(*) AS c FROM security_companies WHERE true",
            ["name", "province"]
          );
          break;
        case "saps":
          columns = ["saps_id", "station_name", "address", "phone", "province"];
          await paged(
            "SELECT saps_id, station_name, address, phone, email, province, cluster, lat, lng FROM saps_precincts WHERE true",
            "SELECT COUNT(*) AS c FROM saps_precincts WHERE true",
            ["station_name", "address", "province"]
          );
          break;
        case "solar":
          columns = ["id", "address_raw", "suburb", "solar_ghi_kwh_year", "solar_pv_output_kwh_year"];
          await paged(
            "SELECT id, address_raw, suburb, city, solar_ghi_kwh_year, solar_pv_output_kwh_year FROM properties WHERE solar_ghi_kwh_year IS NOT NULL",
            "SELECT COUNT(*) AS c FROM properties WHERE solar_ghi_kwh_year IS NOT NULL",
            ["address_raw", "suburb"]
          );
          break;
        case "feedback":
          columns = ["id", "section", "feedback", "rating", "status", "created_at"];
          await paged(
            "SELECT id, property_id, section, feedback, rating, status, created_at FROM data_feedback WHERE true",
            "SELECT COUNT(*) AS c FROM data_feedback WHERE true",
            ["section", "feedback"]
          );
          break;
        case "crime_detailed": case "security_community": case "water_quality": case "water_detailed":
        case "dolomite": case "social_concerns": case "school_proximity": case "climate":
        case "electricity": case "loadshedding": case "sold_prices": case "fibre_coverage": case "sewerage_quality": {
          const riskType = type === "water_detailed" ? "water_quality" : type;
          columns = ["suburb", "city", "risk_level", "risk_score", "source_name", "data_date"];
          const s = searchWhere(["suburb", "city", "source_name"], 2);
          totalCount = Number((await query(`SELECT COUNT(*) AS c FROM area_risk_data WHERE risk_type = $1 ${s.clause}`, [riskType, ...s.params]))[0]?.c || 0);
          rows = await query(
            `SELECT suburb, city, risk_type, risk_level, risk_score, details, source_name, source_url, data_date FROM area_risk_data WHERE risk_type = $1 ${s.clause} ORDER BY suburb, city LIMIT ${perPage} OFFSET ${offset}`,
            [riskType, ...s.params]
          );
          rows = rows.map(r => {
            const d = typeof r.details === 'string' ? JSON.parse(r.details as string) : r.details as Record<string, unknown>;
            return { ...r, details: undefined, ...(d && typeof d === 'object' ? Object.fromEntries(Object.entries(d).filter(([, v]) => typeof v !== 'object').slice(0, 6)) : {}) };
          });
          break;
        }
        case "gvr":
          columns = ["id", "address_raw", "suburb", "gvr_source", "stand_size_sqm", "zoning", "municipal_value"];
          await paged(
            "SELECT id, address_raw, suburb, city, gvr_source, stand_size_sqm, zoning, municipal_value FROM properties WHERE gvr_source IS NOT NULL",
            "SELECT COUNT(*) AS c FROM properties WHERE gvr_source IS NOT NULL",
            ["address_raw", "suburb"]
          );
          break;
        default:
          return NextResponse.json({ error: "Unknown data type" }, { status: 400 });
      }
    } catch (e) {
      return NextResponse.json({ error: String(e) }, { status: 500 });
    }

    const totalPages = Math.ceil(totalCount / perPage);
    return NextResponse.json({ type, rows, columns, total: totalCount, page, totalPages, perPage });
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
    const { image_base64, image_media_type, rag_enabled = true, property_id } = body;
    if (!image_base64) return NextResponse.json({ error: "image_base64 required — upload a photo" }, { status: 400 });

    // Baseline: Nico's core prompt with NO context, NO KB, NO area data
    const nicoBasePrompt = await _readNicoBasePrompt();

    // RAG: Use the REAL getNicoPrompt() from vision.js — pulls ALL data sources
    let ragPrompt = nicoBasePrompt;
    let ragContext: Record<string, unknown> = {};
    const kbNames: string[] = [];
    let kbCount = 0;

    if (rag_enabled) {
      try {
        const visionPath = path.resolve(process.cwd(), "..", "vision.js");
        const vision = await import(/* webpackIgnore: true */ visionPath);
        const getNicoPrompt = vision.getNicoPrompt || vision.default?.getNicoPrompt;

        if (getNicoPrompt) {
          // If a property_id was provided, load its full context
          let propertyContext: Record<string, unknown> | null = null;
          if (property_id) {
            const props = await query("SELECT * FROM properties WHERE id = $1", [property_id]);
            if (props[0]) {
              const p = props[0] as Record<string, unknown>;
              propertyContext = {
                construction_era: p.construction_era,
                suburb: p.suburb,
                city: p.city,
                roof_material: p.roof_material,
                water_quality_score: p.water_quality_score,
                sewerage_quality_score: p.sewerage_quality_score,
                dolomite_risk: p.dolomite_risk,
                mining_subsidence_risk: p.mining_subsidence_risk,
                flood_zone: p.flood_zone,
                flood_zone_type: p.flood_zone_type,
                heritage_site: p.heritage_site,
                heritage_grade: p.heritage_grade,
                municipal_value: p.municipal_value,
                asking_price: p.asking_price,
                stand_size_sqm: p.stand_size_sqm,
                floor_area_sqm: p.floor_area_sqm,
                bedrooms: p.bedrooms,
                bathrooms: p.bathrooms,
                zoning: p.zoning,
              };
              // Add deeds data
              const deeds = await query("SELECT registered_owner, title_deed_ref, municipal_value FROM deeds_data WHERE property_id = $1 ORDER BY fetched_at DESC LIMIT 1", [property_id]);
              if (deeds[0]) {
                propertyContext.registered_owner = (deeds[0] as Record<string, unknown>).registered_owner;
                propertyContext.title_deed_ref = (deeds[0] as Record<string, unknown>).title_deed_ref;
              }
            }
          }

          // Call the real getNicoPrompt() — it pulls KB entries, suburb patterns,
          // ALL area_risk_data, holly evidence, user corrections, everything
          ragPrompt = await getNicoPrompt(propertyContext);
          ragContext = propertyContext || {};
        }
      } catch (err) {
        // Fallback: if vision.js import fails, build context manually
        console.error("Failed to import vision.js getNicoPrompt:", err);
      }

      // Get KB names for signal detection regardless of how we built the prompt
      try {
        const kbRows = await query("SELECT name FROM rag_knowledge_entries WHERE status = 'active'");
        kbCount = kbRows.length;
        for (const r of kbRows) kbNames.push((r as Record<string, unknown>).name as string);
      } catch {}
    }

    const imageContent = {
      type: "image" as const,
      source: { type: "base64" as const, media_type: (image_media_type || "image/jpeg") as "image/jpeg" | "image/png" | "image/gif" | "image/webp", data: image_base64 },
    };

    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const claude = new Anthropic();

    // Run both in parallel — same image, SAME model (production), different prompts
    const [withoutRag, withRag] = await Promise.all([
      claude.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        system: nicoBasePrompt,
        messages: [{ role: "user", content: [imageContent, { type: "text", text: "Analyse this property photo." }] }],
      }),
      claude.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        system: ragPrompt,
        messages: [{ role: "user", content: [imageContent, { type: "text", text: "Analyse this property photo." }] }],
      }),
    ]);

    const responseWithout = withoutRag.content[0].type === "text" ? withoutRag.content[0].text : "";
    const responseWith = withRag.content[0].type === "text" ? withRag.content[0].text : "";

    const signals = _detectRagSignals(responseWithout, responseWith, kbNames);

    // Count how many data sources were actually injected into the RAG prompt
    const ragSections = (ragPrompt.match(/\n\n[A-Z][A-Z\s&—]+\(/g) || []).length;

    return NextResponse.json({
      ok: true,
      response_without_rag: responseWithout,
      response_with_rag: responseWith,
      kb_entries_used: kbCount,
      rag_sections: ragSections,
      rag_prompt_length: ragPrompt.length,
      baseline_prompt_length: nicoBasePrompt.length,
      property_context: ragContext,
      signals,
    });
  }

  // ─── Batch benchmark: run comparison across multiple property photos ──
  if (action === "run_benchmark") {
    const count = Math.min(body.count || 10, 20);
    const rag_enabled_bench = body.rag_enabled !== false;

    // Pick random analysed photos with findings — include full property data
    const photos = await query(`
      SELECT pi.id, pi.image_url, pi.vision_analysis->>'photo_type' AS photo_type,
             p.id AS property_id, p.address_raw, p.suburb, p.city, p.construction_era,
             p.roof_material, p.water_quality_score, p.sewerage_quality_score,
             p.dolomite_risk, p.mining_subsidence_risk, p.flood_zone,
             p.municipal_value, p.asking_price, p.stand_size_sqm, p.floor_area_sqm,
             p.bedrooms, p.bathrooms
      FROM property_images pi
      JOIN properties p ON p.id = pi.property_id
      WHERE pi.vision_analysis IS NOT NULL
        AND pi.image_url IS NOT NULL AND pi.image_url LIKE 'http%'
        AND jsonb_typeof(pi.vision_analysis->'findings') = 'array'
        AND jsonb_array_length(pi.vision_analysis->'findings') > 0
      ORDER BY RANDOM() LIMIT ${count}
    `);

    if (photos.length === 0) {
      return NextResponse.json({ ok: false, error: "No analysed photos with findings available" });
    }

    const nicoBasePrompt = await _readNicoBasePrompt();

    // Load the real getNicoPrompt from vision.js
    let getNicoPrompt: ((ctx: Record<string, unknown> | null) => Promise<string>) | null = null;
    if (rag_enabled_bench) {
      try {
        const visionPath = path.resolve(process.cwd(), "..", "vision.js");
        const vision = await import(/* webpackIgnore: true */ visionPath);
        getNicoPrompt = vision.getNicoPrompt || vision.default?.getNicoPrompt;
      } catch {}
    }

    // Get KB names for signal detection
    const kbNames: string[] = [];
    try {
      const kbRows = await query("SELECT name FROM rag_knowledge_entries WHERE status = 'active'");
      for (const r of kbRows) kbNames.push((r as Record<string, unknown>).name as string);
    } catch {}

    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const claude = new Anthropic();

    // Fetch images and run comparisons (sequential to avoid rate limits)
    const results: Record<string, unknown>[] = [];
    for (const photo of photos) {
      try {
        // Fetch the image
        const imgResponse = await fetch(photo.image_url as string);
        if (!imgResponse.ok) continue;
        const imgBuffer = await imgResponse.arrayBuffer();
        const base64 = Buffer.from(imgBuffer).toString("base64");
        const contentType = imgResponse.headers.get("content-type") || "image/jpeg";

        // Build the full RAG prompt for THIS property's context
        let ragPrompt = nicoBasePrompt;
        if (getNicoPrompt && rag_enabled_bench) {
          try {
            ragPrompt = await getNicoPrompt({
              construction_era: photo.construction_era,
              suburb: photo.suburb,
              city: photo.city,
              roof_material: photo.roof_material,
              water_quality_score: photo.water_quality_score,
              sewerage_quality_score: photo.sewerage_quality_score,
              dolomite_risk: photo.dolomite_risk,
              mining_subsidence_risk: photo.mining_subsidence_risk,
              flood_zone: photo.flood_zone,
              municipal_value: photo.municipal_value,
              asking_price: photo.asking_price,
              stand_size_sqm: photo.stand_size_sqm,
              floor_area_sqm: photo.floor_area_sqm,
              bedrooms: photo.bedrooms,
              bathrooms: photo.bathrooms,
            });
          } catch {}
        }

        const imageContent = {
          type: "image" as const,
          source: { type: "base64" as const, media_type: contentType as "image/jpeg" | "image/png" | "image/gif" | "image/webp", data: base64 },
        };

        const [withoutRag, withRag] = await Promise.all([
          claude.messages.create({
            model: "claude-sonnet-4-6",
            max_tokens: 4096,
            system: nicoBasePrompt,
            messages: [{ role: "user", content: [imageContent, { type: "text", text: "Analyse this property photo." }] }],
          }),
          claude.messages.create({
            model: "claude-sonnet-4-6",
            max_tokens: 4096,
            system: ragPrompt,
            messages: [{ role: "user", content: [imageContent, { type: "text", text: "Analyse this property photo." }] }],
          }),
        ]);

        const responseWithout = withoutRag.content[0].type === "text" ? withoutRag.content[0].text : "";
        const responseWith = withRag.content[0].type === "text" ? withRag.content[0].text : "";
        const signals = _detectRagSignals(responseWithout, responseWith, kbNames);

        results.push({
          image_id: photo.id,
          image_url: photo.image_url,
          photo_type: photo.photo_type,
          property_id: photo.property_id,
          address: photo.address_raw,
          suburb: photo.suburb,
          rag_prompt_length: ragPrompt.length,
          response_without_rag: responseWithout,
          response_with_rag: responseWith,
          signals,
        });
      } catch {
        // Skip failed images
      }
    }

    // Aggregate signal scores across all results
    const aggregate = _aggregateSignals(results.map(r => r.signals as ReturnType<typeof _detectRagSignals>));

    return NextResponse.json({
      ok: true,
      photos_tested: results.length,
      kb_entries_active: kbNames.length,
      aggregate,
      results,
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
