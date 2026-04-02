import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { withAuth } from "@/lib/auth";

export const GET = withAuth(async (_req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;

  const orders = await query(
    `SELECT o.*, p.*, d.registered_owner, d.title_deed_ref, d.municipal_value, d.transfer_history
     FROM orders o
     JOIN properties p ON p.id = o.property_id
     LEFT JOIN deeds_data d ON d.property_id = p.id
     WHERE o.id = $1`,
    [id]
  );
  if (!orders.length) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const order = orders[0];
  let report = null;

  if (order.report_id) {
    const reports = await query("SELECT * FROM property_reports WHERE id = $1", [order.report_id]);
    report = reports[0] || null;
  }

  return NextResponse.json({ order, report });
}) as (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<NextResponse>;

export const POST = withAuth(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const { action } = await req.json();

  if (action === "mark_delivered") {
    await query("UPDATE orders SET report_delivered_at = NOW() WHERE id = $1", [id]);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}) as (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<NextResponse>;
