import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { withAuth } from "@/lib/auth";

interface SourceConfig {
  key: string;
  label: string;
  layer: string;
  table: string;         // primary table name
  alias: string;         // alias used in queries
  listQuery: string;     // base query WITHOUT WHERE/ORDER — we add those
  countQuery: string;    // count query for summary card
  orderBy: string;       // ORDER BY clause
}

const SOURCES: SourceConfig[] = [
  {
    key: "area_risk_data", label: "Area Risk Data", layer: "live / crime", table: "area_risk_data", alias: "ard",
    listQuery: `SELECT ard.id, ard.suburb, ard.city, ard.risk_type, ard.risk_level, ard.risk_score, ard.source_name, ard.source_url, ard.data_date, ard.rag_status, ard.created_at, ard.details::text AS details_json FROM area_risk_data ard`,
    countQuery: `SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE rag_status='approved') as approved, COUNT(*) FILTER (WHERE rag_status='rejected') as rejected, COUNT(*) FILTER (WHERE rag_status='pending_review') as pending_review, COUNT(*) FILTER (WHERE rag_status='pending') as pending, COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM rag_chunks rc WHERE rc.source_table='area_risk_data' AND rc.source_id=area_risk_data.id)) as in_rag FROM area_risk_data`,
    orderBy: "ard.created_at DESC",
  },
  {
    key: "properties", label: "Properties", layer: "property", table: "properties", alias: "p",
    listQuery: `SELECT p.id, p.suburb, p.city, p.address_raw, p.asking_price, p.bedrooms, p.property_type, p.rag_status, p.created_at FROM properties p WHERE p.suburb IS NOT NULL`,
    countQuery: `SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE rag_status='approved') as approved, COUNT(*) FILTER (WHERE rag_status='rejected') as rejected, COUNT(*) FILTER (WHERE rag_status='pending_review') as pending_review, COUNT(*) FILTER (WHERE rag_status='pending') as pending, COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM rag_chunks rc WHERE rc.source_table='properties' AND rc.source_id=properties.id)) as in_rag FROM properties WHERE suburb IS NOT NULL`,
    orderBy: "p.created_at DESC",
  },
  {
    key: "holly_evidence", label: "Vision Evidence", layer: "evidence", table: "holly_evidence", alias: "he",
    listQuery: `SELECT he.id, he.category, he.severity, he.observation, he.what_i_see, he.defect_or_risk, he.sa_context, he.cost_min_zar, he.cost_max_zar, p.suburb, p.city, he.rag_status, he.created_at FROM holly_evidence he JOIN properties p ON p.id = he.property_id`,
    countQuery: `SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE rag_status='approved') as approved, COUNT(*) FILTER (WHERE rag_status='rejected') as rejected, COUNT(*) FILTER (WHERE rag_status='pending_review') as pending_review, COUNT(*) FILTER (WHERE rag_status='pending') as pending, COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM rag_chunks rc WHERE rc.source_table='holly_evidence' AND rc.source_id=holly_evidence.id)) as in_rag FROM holly_evidence`,
    orderBy: "he.created_at DESC",
  },
  {
    key: "security_companies", label: "Security Companies", layer: "security_company", table: "security_companies", alias: "sc",
    listQuery: `SELECT sc.id, sc.name, sc.province, sc.armed_response, sc.google_rating, sc.google_review_count, sc.rag_status, sc.created_at FROM security_companies sc`,
    countQuery: `SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE rag_status='approved') as approved, COUNT(*) FILTER (WHERE rag_status='rejected') as rejected, COUNT(*) FILTER (WHERE rag_status='pending_review') as pending_review, COUNT(*) FILTER (WHERE rag_status='pending') as pending, COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM rag_chunks rc WHERE rc.source_table='security_companies' AND rc.source_id=security_companies.id)) as in_rag FROM security_companies`,
    orderBy: "sc.name",
  },
  {
    key: "property_reports", label: "Property Reports", layer: "report", table: "property_reports", alias: "pr",
    listQuery: `SELECT pr.id, pr.decision, pr.decision_reasoning, pr.property_id, p.suburb, p.city, p.address_raw, pr.rag_status, pr.created_at FROM property_reports pr JOIN properties p ON p.id = pr.property_id`,
    countQuery: `SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE rag_status='approved') as approved, COUNT(*) FILTER (WHERE rag_status='rejected') as rejected, COUNT(*) FILTER (WHERE rag_status='pending_review') as pending_review, COUNT(*) FILTER (WHERE rag_status='pending') as pending, COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM rag_chunks rc WHERE rc.source_table='property_reports' AND rc.source_id=property_reports.id)) as in_rag FROM property_reports`,
    orderBy: "pr.created_at DESC",
  },
  {
    key: "data_feedback", label: "User Feedback", layer: "feedback", table: "data_feedback", alias: "df",
    listQuery: `SELECT df.id, df.section, df.rating, df.feedback, df.finding_hash, df.page_url, p.suburb, df.rag_status, df.created_at FROM data_feedback df LEFT JOIN properties p ON p.id = df.property_id`,
    countQuery: `SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE rag_status='approved') as approved, COUNT(*) FILTER (WHERE rag_status='rejected') as rejected, COUNT(*) FILTER (WHERE rag_status='pending_review') as pending_review, COUNT(*) FILTER (WHERE rag_status='pending') as pending, COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM rag_chunks rc WHERE rc.source_table='data_feedback' AND rc.source_id=data_feedback.id)) as in_rag FROM data_feedback`,
    orderBy: "df.created_at DESC",
  },
  {
    key: "rag_knowledge_entries", label: "Articles", layer: "knowledge", table: "rag_knowledge_entries", alias: "rke",
    listQuery: `SELECT rke.id, rke.name, rke.category, rke.severity, rke.status, rke.description, rke.visual_indicators, rke.sa_context, rke.cost_min_zar, rke.cost_max_zar, rke.source_url, rke.rag_status, rke.created_at FROM rag_knowledge_entries rke`,
    countQuery: `SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE rag_status='approved') as approved, COUNT(*) FILTER (WHERE rag_status='rejected') as rejected, COUNT(*) FILTER (WHERE rag_status='pending_review') as pending_review, COUNT(*) FILTER (WHERE rag_status='pending') as pending, COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM rag_chunks rc WHERE rc.source_table='rag_knowledge_entries' AND rc.source_id=rag_knowledge_entries.id)) as in_rag FROM rag_knowledge_entries`,
    orderBy: "rke.created_at DESC",
  },
  {
    key: "crime_incidents", label: "Crime Data (by suburb)", layer: "crime", table: "crime_incidents", alias: "ci",
    listQuery: `SELECT MIN(ci.id) as id, ci.suburb, ci.city, COUNT(*) as incident_count, COUNT(DISTINCT ci.incident_type) as type_count, MAX(ci.incident_date) as latest_date, MIN(ci.incident_date) as earliest_date, 'approved' as rag_status, MAX(ci.created_at) as created_at FROM crime_incidents ci GROUP BY ci.suburb, ci.city`,
    countQuery: `SELECT COUNT(DISTINCT (suburb||'|'||city)) as total, COUNT(DISTINCT (suburb||'|'||city)) as approved, 0 as rejected, 0 as pending_review, (SELECT COUNT(*) FROM rag_chunks WHERE layer='crime') as in_rag FROM crime_incidents`,
    orderBy: "incident_count DESC",
  },
];

export const GET = withAuth(async (req: NextRequest) => {
  const source = req.nextUrl.searchParams.get("source");
  const page = parseInt(req.nextUrl.searchParams.get("page") || "1");
  const filter = req.nextUrl.searchParams.get("filter") || "all";
  const limit = 50;
  const offset = (page - 1) * limit;

  // Summary view
  if (!source) {
    const summary = [];
    for (const s of SOURCES) {
      try {
        const rows = await query(s.countQuery);
        summary.push({ key: s.key, label: s.label, layer: s.layer, ...rows[0] });
      } catch (e) {
        summary.push({ key: s.key, label: s.label, layer: s.layer, total: 0, approved: 0, rejected: 0, pending_review: 0, in_rag: 0, error: (e as Error).message });
      }
    }
    return NextResponse.json({ sources: summary });
  }

  // Detail view
  const cfg = SOURCES.find(s => s.key === source);
  if (!cfg) return NextResponse.json({ error: "Unknown source" }, { status: 400 });

  try {
    // Build filter clause using the alias
    let filterClause = "";
    if (filter === "approved") filterClause = ` AND ${cfg.alias}.rag_status = 'approved'`;
    else if (filter === "rejected") filterClause = ` AND ${cfg.alias}.rag_status = 'rejected'`;
    else if (filter === "pending") filterClause = ` AND ${cfg.alias}.rag_status = 'pending'`;
    else if (filter === "pending_review") filterClause = ` AND ${cfg.alias}.rag_status = 'pending_review'`;
    else if (filter === "not_in_rag") filterClause = ` AND NOT EXISTS (SELECT 1 FROM rag_chunks rc WHERE rc.source_table = '${cfg.table}' AND rc.source_id = ${cfg.alias}.id)`;

    // For grouped queries (crime), filters don't apply the same way
    const isGrouped = cfg.listQuery.includes("GROUP BY");
    const havingClause = isGrouped && filter !== "all" ? "" : ""; // crime doesn't have rag_status per row

    // Build the full query
    const hasWhere = cfg.listQuery.includes(" WHERE ");
    const connector = isGrouped ? " HAVING true" : (hasWhere ? "" : " WHERE true");
    const fullQuery = `${cfg.listQuery}${connector}${isGrouped ? "" : filterClause} ORDER BY ${cfg.orderBy} LIMIT ${limit} OFFSET ${offset}`;

    const rows = await query(fullQuery);

    // Count
    let total = 0;
    if (filter === "all" || isGrouped) {
      // Use a simple count
      const countRows = await query(`SELECT COUNT(*) as cnt FROM (${cfg.listQuery}) sub`);
      total = parseInt(String(countRows[0].cnt));
    } else if (filter === "not_in_rag") {
      const countRows = await query(`SELECT COUNT(*) as cnt FROM ${cfg.table} WHERE NOT EXISTS (SELECT 1 FROM rag_chunks rc WHERE rc.source_table = '${cfg.table}' AND rc.source_id = ${cfg.table}.id)`);
      total = parseInt(String(countRows[0].cnt));
    } else {
      const countRows = await query(`SELECT COUNT(*) as cnt FROM ${cfg.table} WHERE rag_status = $1`, [filter]);
      total = parseInt(String(countRows[0].cnt));
    }

    return NextResponse.json({
      source: cfg.key, label: cfg.label, layer: cfg.layer,
      rows, total, page, pages: Math.ceil(total / limit), filter,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message, source: cfg.key }, { status: 500 });
  }
});

export const POST = withAuth(async (req: NextRequest) => {
  const { action, source, ids, status, filter: bodyFilter } = await req.json();

  if (action === "update_status") {
    if (!source || !ids || !Array.isArray(ids) || !status) {
      return NextResponse.json({ error: "source, ids, and status required" }, { status: 400 });
    }
    if (!["approved", "rejected", "pending", "pending_review"].includes(status)) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }
    const validSources = SOURCES.map(s => s.key);
    if (!validSources.includes(source)) {
      return NextResponse.json({ error: "Invalid source" }, { status: 400 });
    }
    await query(`UPDATE ${source} SET rag_status = $1 WHERE id = ANY($2::int[])`, [status, ids]);
    // For knowledge entries: approved = active, rejected = draft
    if (source === "rag_knowledge_entries") {
      if (status === "approved") await query("UPDATE rag_knowledge_entries SET status = 'active' WHERE id = ANY($1::int[])", [ids]);
      else if (status === "rejected") await query("UPDATE rag_knowledge_entries SET status = 'draft' WHERE id = ANY($1::int[])", [ids]);
    }
    return NextResponse.json({ ok: true });
  }

  // Bulk update all rows matching the current filter
  if (action === "bulk_update_filtered") {
    if (!source || !status) return NextResponse.json({ error: "source and status required" }, { status: 400 });
    const validSources = SOURCES.map(s => s.key);
    if (!validSources.includes(source)) return NextResponse.json({ error: "Invalid source" }, { status: 400 });
    if (!["approved", "rejected", "pending", "pending_review"].includes(status)) return NextResponse.json({ error: "Invalid status" }, { status: 400 });

    const f = bodyFilter || "all";
    let where = "WHERE true";
    if (f === "pending") where = "WHERE rag_status = 'pending'";
    else if (f === "approved") where = "WHERE rag_status = 'approved'";
    else if (f === "rejected") where = "WHERE rag_status = 'rejected'";
    else if (f === "pending_review") where = "WHERE rag_status = 'pending_review'";

    await query(`UPDATE ${source} SET rag_status = $1 ${where}`, [status]);
    // For knowledge entries: approved = active, rejected = draft
    if (source === "rag_knowledge_entries") {
      if (status === "approved") await query(`UPDATE rag_knowledge_entries SET status = 'active' ${where}`);
      else if (status === "rejected") await query(`UPDATE rag_knowledge_entries SET status = 'draft' ${where}`);
    }
    return NextResponse.json({ ok: true });
  }

  if (action === "bulk_activate_filtered") {
    const f = bodyFilter || "all";
    let where = "WHERE true";
    if (f === "pending") where = "WHERE rag_status = 'pending'";
    else if (f === "approved") where = "WHERE rag_status = 'approved'";

    await query(`UPDATE rag_knowledge_entries SET status = 'active' ${where}`);
    return NextResponse.json({ ok: true });
  }

  if (action === "bulk_approve_all") {
    if (!source) return NextResponse.json({ error: "source required" }, { status: 400 });
    await query(`UPDATE ${source} SET rag_status = 'approved' WHERE rag_status != 'rejected'`);
    return NextResponse.json({ ok: true });
  }

  if (action === "activate_knowledge") {
    if (!ids || !Array.isArray(ids)) return NextResponse.json({ error: "ids required" }, { status: 400 });
    await query("UPDATE rag_knowledge_entries SET status = 'active' WHERE id = ANY($1::int[])", [ids]);
    return NextResponse.json({ ok: true });
  }

  if (action === "deactivate_knowledge") {
    if (!ids || !Array.isArray(ids)) return NextResponse.json({ error: "ids required" }, { status: 400 });
    await query("UPDATE rag_knowledge_entries SET status = 'draft' WHERE id = ANY($1::int[])", [ids]);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
});
