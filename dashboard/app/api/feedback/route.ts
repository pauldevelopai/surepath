import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { withAuth } from "@/lib/auth";

export const POST = withAuth(async (req: NextRequest) => {
  const { property_id, section, field_name, feedback, rating, finding_hash, context } = await req.json();
  if (!property_id || !section) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }

  await query(
    "INSERT INTO data_feedback (property_id, section, field_name, feedback, rating, finding_hash, context) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [property_id, section, field_name || null, feedback || null, rating || null, finding_hash || null, context ? JSON.stringify(context) : null]
  );

  return NextResponse.json({ ok: true });
});

// GET: retrieve feedback for a property
export const GET = withAuth(async (req: NextRequest) => {
  const propertyId = req.nextUrl.searchParams.get("property_id");
  if (!propertyId) return NextResponse.json({ error: "Missing property_id" }, { status: 400 });

  const rows = await query(
    "SELECT id, section, field_name, feedback, rating, finding_hash, created_at FROM data_feedback WHERE property_id = $1 ORDER BY created_at DESC",
    [propertyId]
  );

  return NextResponse.json({ feedback: rows });
});
