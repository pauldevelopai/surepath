"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { formatZAR, formatDate, severityColor, decisionColor } from "@/lib/format";

interface Finding {
  category: string;
  observation: string;
  severity: string;
  confidence: string;
  estimated_repair_cost_zar?: { min: number; max: number };
  photo_type?: string;
  finding?: string;
}

export default function OrderDetailPage() {
  const { id } = useParams();
  const [data, setData] = useState<{ order: Record<string, unknown>; report: Record<string, unknown> | null } | null>(null);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    fetch(`/api/orders/${id}`).then((r) => r.json()).then(setData);
  }, [id]);

  if (!data) return <p className="text-gray-500">Loading...</p>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { order: o, report: r } = data as { order: Record<string, any>; report: Record<string, any> | null };

  async function action(act: string) {
    setMsg("Processing...");
    const res = await fetch(`/api/orders/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: act }),
    });
    const json = await res.json();
    setMsg(json.ok ? "Done" : json.error || "Error");
  }

  const sortedFindings = (findings: Finding[]) =>
    [...findings].sort((a, b) => {
      const order: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, COSMETIC: 4 };
      return (order[a.severity] ?? 5) - (order[b.severity] ?? 5);
    });

  return (
    <div className="max-w-4xl">
      <h1 className="text-2xl font-bold mb-1">Order #{String(o.id)}</h1>
      <p className="text-gray-500 mb-6">{String(o.address_normalised || o.address_raw)}</p>

      {/* Order info */}
      <div className="grid grid-cols-2 gap-4 mb-6 text-sm">
        <div><span className="text-gray-500">Phone:</span> {String(o.phone_number)}</div>
        <div><span className="text-gray-500">Payment:</span> {String(o.payment_status)}</div>
        <div><span className="text-gray-500">Price:</span> R{String(o.price_zar)}</div>
        <div><span className="text-gray-500">Resale:</span> {o.was_resale ? "Yes" : "No"}</div>
        <div><span className="text-gray-500">Asking Price:</span> {r ? formatZAR(r.asking_price as number) : "N/A"}</div>
        <div><span className="text-gray-500">Created:</span> {formatDate(o.created_at as string)}</div>
      </div>

      {/* Actions */}
      <div className="flex gap-2 mb-6">
        <button onClick={() => action("regenerate")} className="bg-[#0D1B2A] text-white px-4 py-2 rounded text-sm hover:bg-gray-800">Regenerate Report</button>
        <button onClick={() => action("resend_pdf")} className="bg-[#0D1B2A] text-white px-4 py-2 rounded text-sm hover:bg-gray-800">Resend PDF to WhatsApp</button>
        <button onClick={() => action("mark_delivered")} className="bg-green-600 text-white px-4 py-2 rounded text-sm hover:bg-green-700">Mark as Delivered</button>
        {r?.pdf_url ? (
          <a href={String(r.pdf_url)} target="_blank" rel="noreferrer" className="bg-gray-200 text-gray-800 px-4 py-2 rounded text-sm hover:bg-gray-300">View PDF</a>
        ) : null}
      </div>
      {msg && <p className="text-sm text-blue-600 mb-4">{msg}</p>}

      {!r ? (
        <p className="text-gray-400">No report generated yet.</p>
      ) : (
        <div className="space-y-6">
          {/* Decision */}
          <div className="bg-[#0D1B2A] text-white rounded-lg p-8 text-center">
            <div className={`text-4xl font-bold tracking-widest ${decisionColor[String(r.decision)] || ""}`} style={{ color: r.decision === "BUY" ? "#27AE60" : r.decision === "NEGOTIATE" ? "#F1C40F" : r.decision === "WALK_AWAY" ? "#E63946" : "#F1C40F" }}>
              {String(r.decision)}
            </div>
            <p className="mt-4 text-gray-300">{String(r.decision_reasoning)}</p>
          </div>

          {/* Ownership */}
          {o.registered_owner && (
            <section>
              <h2 className="text-lg font-bold border-b-2 border-[#E63946] pb-1 mb-3">Ownership History</h2>
              <div className="text-sm space-y-1">
                <p><strong>Owner:</strong> {String(o.registered_owner)}</p>
                <p><strong>Title Deed:</strong> {String(o.title_deed_ref || "N/A")}</p>
                <p><strong>Municipal Value:</strong> {formatZAR(o.municipal_value as number)}</p>
              </div>
              {Array.isArray(o.transfer_history) && o.transfer_history.length > 0 && (
                <table className="w-full text-sm mt-2 border-collapse">
                  <thead><tr className="bg-gray-100"><th className="px-2 py-1 text-left">Date</th><th className="px-2 py-1 text-left">Price</th><th className="px-2 py-1 text-left">Buyer</th><th className="px-2 py-1 text-left">Seller</th></tr></thead>
                  <tbody>
                    {(o.transfer_history as Array<{ date: string; price: number; buyer: string; seller: string }>).map((t, i) => (
                      <tr key={i} className="border-b"><td className="px-2 py-1">{t.date}</td><td className="px-2 py-1">{formatZAR(t.price)}</td><td className="px-2 py-1">{t.buyer}</td><td className="px-2 py-1">{t.seller}</td></tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          )}

          {/* Price Analysis */}
          <section>
            <h2 className="text-lg font-bold border-b-2 border-[#E63946] pb-1 mb-3">Price Analysis</h2>
            <div className="grid grid-cols-3 gap-4 text-sm">
              <div className="bg-gray-50 p-3 rounded"><div className="text-gray-500 text-xs">Asking</div><div className="font-bold">{formatZAR(r.asking_price as number)}</div></div>
              <div className="bg-gray-50 p-3 rounded"><div className="text-gray-500 text-xs">AVM Range</div><div className="font-bold">{formatZAR(r.avm_low as number)} – {formatZAR(r.avm_high as number)}</div></div>
              <div className="bg-gray-50 p-3 rounded"><div className="text-gray-500 text-xs">Verdict</div><div className="font-bold uppercase">{String(r.price_verdict)}</div></div>
            </div>
          </section>

          {/* Comparables */}
          {Array.isArray(r.comparables) && r.comparables.length > 0 && (
            <section>
              <h2 className="text-lg font-bold border-b-2 border-[#E63946] pb-1 mb-3">Comparables</h2>
              <table className="w-full text-sm border-collapse">
                <thead><tr className="bg-gray-100"><th className="px-2 py-1 text-left">Address</th><th className="px-2 py-1 text-left">Price</th><th className="px-2 py-1 text-left">Sold</th><th className="px-2 py-1 text-left">Size</th></tr></thead>
                <tbody>
                  {(r.comparables as Array<{ address: string; price: number; sold_date: string; size_sqm: number }>).map((c, i) => (
                    <tr key={i} className="border-b"><td className="px-2 py-1">{c.address}</td><td className="px-2 py-1">{formatZAR(c.price)}</td><td className="px-2 py-1">{c.sold_date}</td><td className="px-2 py-1">{c.size_sqm}m²</td></tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {/* Suburb Intelligence */}
          {r.suburb_intelligence && (
            <section>
              <h2 className="text-lg font-bold border-b-2 border-[#E63946] pb-1 mb-3">Suburb Intelligence</h2>
              <div className="grid grid-cols-2 gap-2 text-sm">
                {Object.entries(r.suburb_intelligence as Record<string, unknown>).map(([k, v]) => (
                  <div key={k} className="bg-gray-50 p-2 rounded"><span className="text-gray-500">{k.replace(/_/g, " ")}:</span> {String(v)}</div>
                ))}
              </div>
            </section>
          )}

          {/* Vision Findings */}
          {Array.isArray(r.vision_findings) && r.vision_findings.length > 0 && (
            <section>
              <h2 className="text-lg font-bold border-b-2 border-[#E63946] pb-1 mb-3">Visual Findings</h2>
              <div className="space-y-2">
                {sortedFindings(r.vision_findings as Finding[]).map((f, i) => (
                  <div key={i} className="flex items-start gap-2 bg-gray-50 p-3 rounded border-l-4" style={{ borderColor: f.severity === "CRITICAL" ? "#E63946" : f.severity === "HIGH" ? "#E67E22" : f.severity === "MEDIUM" ? "#F1C40F" : "#27AE60" }}>
                    <span className={`px-2 py-0.5 rounded text-xs font-bold shrink-0 ${severityColor[f.severity] || "bg-gray-200"}`}>{f.severity}</span>
                    <div>
                      <div className="text-sm">{f.observation || f.finding}</div>
                      {f.estimated_repair_cost_zar && <div className="text-xs text-gray-500 mt-1">Est. repair: {formatZAR(f.estimated_repair_cost_zar.min)} – {formatZAR(f.estimated_repair_cost_zar.max)}</div>}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Asbestos Risk */}
          <section>
            <h2 className="text-lg font-bold border-b-2 border-[#E63946] pb-1 mb-3">Asbestos Risk</h2>
            <span className={`px-3 py-1 rounded text-sm font-bold ${severityColor[String(r.asbestos_risk)] || "bg-gray-200"}`}>{String(r.asbestos_risk)}</span>
          </section>

          {/* Compliance Flags */}
          {Array.isArray(r.compliance_flags) && r.compliance_flags.length > 0 && (
            <section>
              <h2 className="text-lg font-bold border-b-2 border-[#E63946] pb-1 mb-3">Compliance Flags</h2>
              {(r.compliance_flags as Array<{ observation: string; severity: string }>).map((f, i) => (
                <div key={i} className="bg-yellow-50 p-3 rounded border-l-4 border-yellow-400 mb-2 text-sm">
                  <span className={`px-2 py-0.5 rounded text-xs font-bold mr-2 ${severityColor[f.severity] || ""}`}>{f.severity}</span>
                  {f.observation}
                </div>
              ))}
            </section>
          )}

          {/* Repair Estimates */}
          {r.repair_estimates && (
            <section>
              <h2 className="text-lg font-bold border-b-2 border-[#E63946] pb-1 mb-3">What Needs Fixing</h2>
              {Array.isArray((r.repair_estimates as { items?: unknown[] }).items) && (
                <table className="w-full text-sm border-collapse mb-2">
                  <thead><tr className="bg-gray-100"><th className="px-2 py-1 text-left">Category</th><th className="px-2 py-1 text-left">Description</th><th className="px-2 py-1 text-left">Min</th><th className="px-2 py-1 text-left">Max</th></tr></thead>
                  <tbody>
                    {((r.repair_estimates as { items: Array<{ category: string; description: string; min: number; max: number }> }).items).map((item, i) => (
                      <tr key={i} className="border-b"><td className="px-2 py-1 capitalize">{item.category}</td><td className="px-2 py-1">{item.description}</td><td className="px-2 py-1">{formatZAR(item.min)}</td><td className="px-2 py-1">{formatZAR(item.max)}</td></tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="text-sm font-bold">Total: {formatZAR((r.repair_estimates as { total_min_zar: number }).total_min_zar)} – {formatZAR((r.repair_estimates as { total_max_zar: number }).total_max_zar)}</p>
            </section>
          )}

          {/* B2B Scores */}
          <section>
            <h2 className="text-lg font-bold border-b-2 border-[#E63946] pb-1 mb-3">B2B Scores</h2>
            <div className="grid grid-cols-3 gap-4">
              {[
                { label: "Insurance Risk", val: r.insurance_risk_score as number },
                { label: "Solar Suitability", val: r.solar_suitability_score as number },
                { label: "Crime Risk", val: r.crime_risk_score as number },
              ].map((s) => (
                <div key={s.label} className="bg-gray-50 p-3 rounded text-center">
                  <div className="text-xs text-gray-500 mb-1">{s.label}</div>
                  <div className="text-2xl font-bold">{s.val ?? "N/A"}<span className="text-sm text-gray-400">/10</span></div>
                  <div className="w-full bg-gray-200 rounded-full h-2 mt-2">
                    <div className="h-2 rounded-full" style={{ width: `${(s.val || 0) * 10}%`, background: (s.val || 0) >= 7 ? "#E63946" : (s.val || 0) >= 4 ? "#F1C40F" : "#27AE60" }} />
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-3 text-sm"><strong>Maintenance Estimate:</strong> {formatZAR(r.maintenance_cost_estimate as number)}</div>
            {Array.isArray(r.trades_flags) && r.trades_flags.length > 0 && (
              <div className="mt-3">
                <strong className="text-sm">Trades Flags:</strong>
                {(r.trades_flags as Array<{ trade_type: string; items?: Array<{ observation?: string; description?: string }> }>).map((t, i) => (
                  <div key={i} className="ml-4 text-sm mt-1">
                    <span className="font-medium capitalize">{t.trade_type}</span>
                    {t.items?.map((item, j) => <div key={j} className="ml-4 text-gray-600">- {item.observation || item.description}</div>)}
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Negotiation Intel */}
          {r.negotiation_intel && (
            <section>
              <h2 className="text-lg font-bold border-b-2 border-[#E63946] pb-1 mb-3">Negotiation Intelligence</h2>
              <div className="text-sm space-y-1">
                <p><strong>Suggested Offer:</strong> {formatZAR((r.negotiation_intel as { suggested_offer: number }).suggested_offer)}</p>
                <p><strong>Days on Market:</strong> {String((r.negotiation_intel as { days_on_market: number }).days_on_market)}</p>
                {Array.isArray((r.negotiation_intel as { negotiation_points?: string[] }).negotiation_points) && (
                  <ul className="list-disc list-inside">
                    {((r.negotiation_intel as { negotiation_points: string[] }).negotiation_points).map((p, i) => <li key={i}>{p}</li>)}
                  </ul>
                )}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
