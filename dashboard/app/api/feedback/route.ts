import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { withAuth } from "@/lib/auth";

export const POST = withAuth(async (req: NextRequest) => {
  const { property_id, section, field_name, feedback, rating, finding_hash, context, page_url, action, id, status } = await req.json();

  // Update feedback status
  if (action === "update_status" && id) {
    await query(
      "UPDATE data_feedback SET status = $1, resolved_at = CASE WHEN $1 = 'resolved' THEN NOW() ELSE NULL END WHERE id = $2",
      [status || "open", id]
    );
    return NextResponse.json({ ok: true });
  }

  // Delete feedback
  if (action === "delete" && id) {
    await query("DELETE FROM data_feedback WHERE id = $1", [id]);
    return NextResponse.json({ ok: true });
  }

  // Create new feedback — property_id is now optional for general feedback
  if (!feedback && !section) {
    return NextResponse.json({ error: "Feedback text or section required" }, { status: 400 });
  }

  await query(
    "INSERT INTO data_feedback (property_id, section, field_name, feedback, rating, finding_hash, context, page_url) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    [property_id || null, section || "general", field_name || null, feedback || null, rating || null, finding_hash || null, context ? JSON.stringify(context) : null, page_url || null]
  );

  return NextResponse.json({ ok: true });
});

export const GET = withAuth(async (req: NextRequest) => {
  const propertyId = req.nextUrl.searchParams.get("property_id");
  const all = req.nextUrl.searchParams.get("all");

  if (all) {
    const rows = await query(`
      SELECT df.*, p.address_raw, p.suburb,
        CASE WHEN df.finding_hash IS NOT NULL AND df.rating IN ('good', 'bad', 'correct', 'incorrect', 'unsure') THEN 'finding_rating' ELSE 'feedback' END AS feedback_type
      FROM data_feedback df
      LEFT JOIN properties p ON p.id = df.property_id
      ORDER BY df.created_at DESC
      LIMIT 200
    `);
    return NextResponse.json({ feedback: rows });
  }

  if (propertyId) {
    const rows = await query(
      "SELECT id, section, field_name, feedback, rating, finding_hash, status, created_at FROM data_feedback WHERE property_id = $1 ORDER BY created_at DESC",
      [propertyId]
    );
    return NextResponse.json({ feedback: rows });
  }

  return NextResponse.json({ error: "Pass ?all=1 or ?property_id=N" }, { status: 400 });
});
