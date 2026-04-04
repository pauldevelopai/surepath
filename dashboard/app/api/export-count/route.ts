import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { withAuth } from "@/lib/auth";

export const POST = withAuth(async (req: NextRequest) => {
  const { property_id } = await req.json();
  if (!property_id) return NextResponse.json({ error: "property_id required" }, { status: 400 });

  await query("UPDATE properties SET pdf_export_count = COALESCE(pdf_export_count, 0) + 1 WHERE id = $1", [property_id]);
  const rows = await query("SELECT pdf_export_count FROM properties WHERE id = $1", [property_id]);

  return NextResponse.json({ ok: true, count: rows[0]?.pdf_export_count || 0 });
});
