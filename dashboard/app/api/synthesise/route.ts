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
    // Run synthesis directly — skip the pipeline's resale check
    const synthesis = await loadModule("synthesis");
    const price = asking_price || prop.asking_price || 0;

    const result = await synthesis.synthesiseReport(parseInt(property_id), price);

    // Render PDF
    const pdf = await loadModule("pdf");
    const pdfUrl = await pdf.renderReport(result.report_id);

    return NextResponse.json({
      ok: true,
      report_id: result.report_id,
      decision: result.report.decision,
      decision_reasoning: result.report.decision_reasoning,
      pdf_url: pdfUrl,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
});
