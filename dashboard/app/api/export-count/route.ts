import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { withAuth } from "@/lib/auth";

export const POST = withAuth(async (req: NextRequest) => {
  const { property_id } = await req.json();
  if (!property_id) return NextResponse.json({ error: "property_id required" }, { status: 400 });

  await query("UPDATE properties SET pdf_export_count = COALESCE(pdf_export_count, 0) + 1 WHERE id = $1", [property_id]);
  await query("INSERT INTO pdf_exports (property_id, source) VALUES ($1, 'web')", [property_id]);
  const rows = await query("SELECT pdf_export_count FROM properties WHERE id = $1", [property_id]);

  return NextResponse.json({ ok: true, count: rows[0]?.pdf_export_count || 0 });
});

export const GET = withAuth(async (req: NextRequest) => {
  const propertyId = req.nextUrl.searchParams.get("property_id");
  if (!propertyId) return NextResponse.json({ error: "property_id required" }, { status: 400 });

  const rows = await query(
    "SELECT id, source, phone_number, file_size_bytes, created_at FROM pdf_exports WHERE property_id = $1 ORDER BY created_at DESC LIMIT 50",
    [propertyId]
  );

  return NextResponse.json({ exports: rows });
});
