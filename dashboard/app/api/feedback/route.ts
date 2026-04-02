import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { withAuth } from "@/lib/auth";

export const POST = withAuth(async (req: NextRequest) => {
  const { property_id, section, field_name, feedback } = await req.json();
  if (!property_id || !section || !feedback) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }

  await query(
    "INSERT INTO data_feedback (property_id, section, field_name, feedback) VALUES ($1, $2, $3, $4)",
    [property_id, section, field_name || null, feedback]
  );

  return NextResponse.json({ ok: true });
});
