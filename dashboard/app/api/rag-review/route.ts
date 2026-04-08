import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { withAuth } from "@/lib/auth";

// Source table configs — what to query and how to build preview text
const SOURCES = [
  {
    key: "area_risk_data",
    label: "Area Risk Data",
    layer: "live / crime",
    query: `SELECT id, suburb, city, risk_type, risk_level, risk_score, source_name, data_date, rag_status, created_at,
              LEFT(details::text, 300) AS details_preview
            FROM area_risk_data ORDER BY created_at DESC`,
    countQuery: `SELECT COUNT(*) as total,
      COUNT(*) FILTER (WHERE rag_status = 'approved') as approved,
      COUNT(*) FILTER (WHERE rag_status = 'rejected') as rejected,
      COUNT(*) FILTER (WHERE rag_status = 'pending_review') as pending_review,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM rag_chunks rc WHERE rc.source_table = 'area_risk_data' AND rc.source_id = area_risk_data.id)) as in_rag
    FROM area_risk_data`,
    preview: (r: Record<string, unknown>) => `${r.risk_type}: ${r.suburb}, ${r.city} — ${r.risk_level || ''} (score ${r.risk_score || '?'})`,
  },
  {
    key: "properties",
    label: "Properties",
    layer: "property",
    query: `SELECT id, suburb, city, address_raw, asking_price, bedrooms, property_type, rag_status, created_at
            FROM properties WHERE suburb IS NOT NULL ORDER BY created_at DESC`,
    countQuery: `SELECT COUNT(*) as total,
      COUNT(*) FILTER (WHERE rag_status = 'approved') as approved,
      COUNT(*) FILTER (WHERE rag_status = 'rejected') as rejected,
      COUNT(*) FILTER (WHERE rag_status = 'pending_review') as pending_review,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM rag_chunks rc WHERE rc.source_table = 'properties' AND rc.source_id = properties.id)) as in_rag
    FROM properties WHERE suburb IS NOT NULL`,
    preview: (r: Record<string, unknown>) => `${r.address_raw || r.suburb} — ${r.bedrooms || '?'}bed ${r.property_type || ''} R${r.asking_price ? Number(r.asking_price).toLocaleString() : '?'}`,
  },
  {
    key: "holly_evidence",
    label: "Vision Evidence",
    layer: "evidence",
    query: `SELECT he.id, he.category, he.severity, he.observation, he.what_i_see, p.suburb, p.city, he.rag_status, he.created_at
            FROM holly_evidence he JOIN properties p ON p.id = he.property_id ORDER BY he.created_at DESC`,
    countQuery: `SELECT COUNT(*) as total,
      COUNT(*) FILTER (WHERE rag_status = 'approved') as approved,
      COUNT(*) FILTER (WHERE rag_status = 'rejected') as rejected,
      COUNT(*) FILTER (WHERE rag_status = 'pending_review') as pending_review,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM rag_chunks rc WHERE rc.source_table = 'holly_evidence' AND rc.source_id = holly_evidence.id)) as in_rag
    FROM holly_evidence`,
    preview: (r: Record<string, unknown>) => `[${r.severity}] ${r.category}: ${((r.what_i_see || r.observation || '') as string).substring(0, 120)}`,
  },
  {
    key: "security_companies",
    label: "Security Companies",
    layer: "security_company",
    query: `SELECT id, name, province, armed_response, google_rating, rag_status, created_at
            FROM security_companies ORDER BY name`,
    countQuery: `SELECT COUNT(*) as total,
      COUNT(*) FILTER (WHERE rag_status = 'approved') as approved,
      COUNT(*) FILTER (WHERE rag_status = 'rejected') as rejected,
      COUNT(*) FILTER (WHERE rag_status = 'pending_review') as pending_review,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM rag_chunks rc WHERE rc.source_table = 'security_companies' AND rc.source_id = security_companies.id)) as in_rag
    FROM security_companies`,
    preview: (r: Record<string, unknown>) => `${r.name} — ${r.province || '?'} ${r.armed_response ? '[armed]' : ''} ${r.google_rating ? r.google_rating + '★' : ''}`,
  },
  {
    key: "property_reports",
    label: "Property Reports",
    layer: "report",
    query: `SELECT pr.id, pr.decision, pr.property_id, p.suburb, p.city, p.address_raw, pr.rag_status, pr.created_at
            FROM property_reports pr JOIN properties p ON p.id = pr.property_id ORDER BY pr.created_at DESC`,
    countQuery: `SELECT COUNT(*) as total,
      COUNT(*) FILTER (WHERE rag_status = 'approved') as approved,
      COUNT(*) FILTER (WHERE rag_status = 'rejected') as rejected,
      COUNT(*) FILTER (WHERE rag_status = 'pending_review') as pending_review,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM rag_chunks rc WHERE rc.source_table = 'property_reports' AND rc.source_id = property_reports.id)) as in_rag
    FROM property_reports`,
    preview: (r: Record<string, unknown>) => `${r.address_raw || r.suburb}: ${r.decision || 'no decision'}`,
  },
  {
    key: "data_feedback",
    label: "User Feedback",
    layer: "feedback",
    query: `SELECT df.id, df.section, df.rating, df.feedback, df.finding_hash, p.suburb, df.rag_status, df.created_at
            FROM data_feedback df LEFT JOIN properties p ON p.id = df.property_id ORDER BY df.created_at DESC`,
    countQuery: `SELECT COUNT(*) as total,
      COUNT(*) FILTER (WHERE rag_status = 'approved') as approved,
      COUNT(*) FILTER (WHERE rag_status = 'rejected') as rejected,
      COUNT(*) FILTER (WHERE rag_status = 'pending_review') as pending_review,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM rag_chunks rc WHERE rc.source_table = 'data_feedback' AND rc.source_id = data_feedback.id)) as in_rag
    FROM data_feedback`,
    preview: (r: Record<string, unknown>) => `[${r.rating || '?'}] ${r.section}: ${((r.feedback || r.finding_hash || '') as string).substring(0, 100)}`,
  },
  {
    key: "rag_knowledge_entries",
    label: "Knowledge Base",
    layer: "knowledge",
    query: `SELECT id, name, category, severity, status, description, rag_status, created_at
            FROM rag_knowledge_entries ORDER BY created_at DESC`,
    countQuery: `SELECT COUNT(*) as total,
      COUNT(*) FILTER (WHERE rag_status = 'approved') as approved,
      COUNT(*) FILTER (WHERE rag_status = 'rejected') as rejected,
      COUNT(*) FILTER (WHERE rag_status = 'pending_review') as pending_review,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM rag_chunks rc WHERE rc.source_table = 'rag_knowledge_entries' AND rc.source_id = rag_knowledge_entries.id)) as in_rag
    FROM rag_knowledge_entries`,
    preview: (r: Record<string, unknown>) => `[${r.category}] ${r.name} — severity ${r.severity}/5 (${r.status})`,
  },
];

export const GET = withAuth(async (req: NextRequest) => {
  const source = req.nextUrl.searchParams.get("source");
  const page = parseInt(req.nextUrl.searchParams.get("page") || "1");
  const filter = req.nextUrl.searchParams.get("filter") || "all"; // all, approved, rejected, pending_review, not_in_rag
  const limit = 50;
  const offset = (page - 1) * limit;

  // Summary view — counts per source
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

  // Detail view — paginated rows for a specific source
  const cfg = SOURCES.find(s => s.key === source);
  if (!cfg) return NextResponse.json({ error: "Unknown source" }, { status: 400 });

  let filterClause = "";
  if (filter === "approved") filterClause = " AND rag_status = 'approved'";
  else if (filter === "rejected") filterClause = " AND rag_status = 'rejected'";
  else if (filter === "pending_review") filterClause = " AND rag_status = 'pending_review'";
  else if (filter === "not_in_rag") filterClause = ` AND NOT EXISTS (SELECT 1 FROM rag_chunks rc WHERE rc.source_table = '${source}' AND rc.source_id = ${source === "property_reports" ? "property_reports" : source === "holly_evidence" ? "holly_evidence" : source === "data_feedback" ? "data_feedback" : source}.id)`;

  // Wrap the base query with filter and pagination
  const baseQuery = cfg.query.replace(" ORDER BY", filterClause + " ORDER BY");
  const rows = await query(baseQuery + ` LIMIT ${limit} OFFSET ${offset}`);

  // Get total count with filter
  const countBase = cfg.countQuery.split("FROM")[1];
  let countSql = `SELECT COUNT(*) as cnt FROM ${countBase}`;
  if (filter !== "all") {
    if (filter === "not_in_rag") {
      countSql = `SELECT COUNT(*) as cnt FROM ${source} WHERE NOT EXISTS (SELECT 1 FROM rag_chunks rc WHERE rc.source_table = '${source}' AND rc.source_id = ${source}.id)`;
    } else {
      countSql = `SELECT COUNT(*) as cnt FROM ${source} WHERE rag_status = '${filter}'`;
    }
  } else {
    countSql = `SELECT COUNT(*) as cnt FROM ${source}`;
  }
  const countResult = await query(countSql).catch(() => [{ cnt: 0 }]);
  const total = parseInt(String(countResult[0].cnt));

  return NextResponse.json({
    source: cfg.key,
    label: cfg.label,
    layer: cfg.layer,
    rows,
    total,
    page,
    pages: Math.ceil(total / limit),
    filter,
  });
});

export const POST = withAuth(async (req: NextRequest) => {
  const { action, source, ids, status } = await req.json();

  if (action === "update_status") {
    if (!source || !ids || !Array.isArray(ids) || !status) {
      return NextResponse.json({ error: "source, ids (array), and status required" }, { status: 400 });
    }
    if (!["approved", "rejected", "pending_review"].includes(status)) {
      return NextResponse.json({ error: "status must be approved, rejected, or pending_review" }, { status: 400 });
    }
    const validSources = SOURCES.map(s => s.key);
    if (!validSources.includes(source)) {
      return NextResponse.json({ error: "Invalid source table" }, { status: 400 });
    }

    const result = await query(
      `UPDATE ${source} SET rag_status = $1 WHERE id = ANY($2::int[])`,
      [status, ids]
    );
    return NextResponse.json({ ok: true, updated: result.length || ids.length });
  }

  if (action === "bulk_approve_all") {
    if (!source) return NextResponse.json({ error: "source required" }, { status: 400 });
    await query(`UPDATE ${source} SET rag_status = 'approved' WHERE rag_status != 'rejected'`);
    return NextResponse.json({ ok: true });
  }

  if (action === "bulk_reject_all") {
    if (!source) return NextResponse.json({ error: "source required" }, { status: 400 });
    await query(`UPDATE ${source} SET rag_status = 'rejected' WHERE rag_status != 'approved'`);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
});
