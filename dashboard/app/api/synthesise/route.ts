import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { withAuth } from "@/lib/auth";
import path from "path";

async function loadModule(name: string) {
  const modPath = path.resolve(process.cwd(), "..", `${name}.js`);
  const mod = await import(/* webpackIgnore: true */ modPath);
  return mod.default || mod;
}

export const POST = withAuth(async (req: NextRequest) => {
  const { property_id, asking_price } = await req.json();
  if (!property_id) return NextResponse.json({ error: "property_id required" }, { status: 400 });

  const properties = await query("SELECT * FROM properties WHERE id = $1", [property_id]);
  if (!properties.length) return NextResponse.json({ error: "Property not found" }, { status: 404 });
  const prop = properties[0];

  try {
    // Render data-driven PDF directly — no AI synthesis
    const pdf = await loadModule("pdf");
    const price = asking_price || prop.asking_price || 0;

    const result = await pdf.exportInspectPagePDF(parseInt(property_id), price);

    return NextResponse.json({
      ok: true,
      report_id: result.reportId,
      decision: "NEGOTIATE",
      decision_reasoning: "Data-driven report — review findings and negotiate accordingly",
      pdf_url: result.pdfUrl,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
});
