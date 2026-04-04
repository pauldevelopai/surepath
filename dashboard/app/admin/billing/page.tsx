"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { formatDate } from "@/lib/format";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type A = Record<string, any>;

function fZAR(n: number | null) { return n != null ? `R${Number(n).toFixed(2)}` : "R0.00"; }
function fUSD(n: number | null) { if (!n || Number(n) === 0) return "$0.00"; const v = Number(n); if (v < 0.01) return `$${v.toFixed(4)}`; return `$${v.toFixed(2)}`; }
function fBytes(n: number | null) { if (!n) return "0 B"; if (n > 1_000_000) return `${(n/1_000_000).toFixed(1)} MB`; if (n > 1000) return `${(n/1000).toFixed(0)} KB`; return `${n} B`; }
const ZAR_RATE = 18.5;

export default function BillingPage() {
  const [data, setData] = useState<A | null>(null);
  const [apiStatus, setApiStatus] = useState<A | null>(null);
  const router = useRouter();
  useEffect(() => {
    fetch("/api/billing").then(r => r.json()).then(setData);
    fetch("/api/api-status").then(r => r.json()).then(setApiStatus);
  }, []);

  if (!data) return <p className="text-gray-500">Loading...</p>;
  const { totals, today, month, by_service, by_endpoint, daily, by_property, data_size, avg_cost, recent, whatsapp } = data;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">Billing &amp; Data Usage</h1>
      <p className="text-sm text-gray-500 mb-4">Tracks every API call across Anthropic, Google, ElevenLabs, and any future services</p>

      {/* Summary */}
      <div className="grid grid-cols-6 gap-3 mb-6">
        {[
          { label: "Total Spent", zar: fZAR(totals.total_zar), usd: fUSD(totals.total_usd), sub: `${totals.total_calls} API calls` },
          { label: "Today", zar: fZAR(today.total_zar), usd: fUSD(Number(today.total_zar) / ZAR_RATE), sub: `${today.calls} calls` },
          { label: "This Month", zar: fZAR(month.total_zar), usd: fUSD(Number(month.total_zar) / ZAR_RATE), sub: `${month.calls} calls` },
          { label: "Avg / Property", zar: fZAR(avg_cost.avg_cost_zar), usd: fUSD(Number(avg_cost.avg_cost_zar || 0) / ZAR_RATE), sub: `max ${fZAR(avg_cost.max_cost_zar)}` },
          { label: "Tokens Used", zar: `${Math.round((Number(totals.total_input_tokens)+Number(totals.total_output_tokens))/1000)}K`, usd: "", sub: `${Math.round(Number(totals.total_input_tokens)/1000)}K in / ${Math.round(Number(totals.total_output_tokens)/1000)}K out` },
          { label: "DB Size", zar: fBytes(Number(data_size.properties_table_bytes)+Number(data_size.images_table_bytes)+Number(data_size.reports_table_bytes)), usd: "", sub: `${data_size.total_properties} properties · ${data_size.total_images} photos` },
        ].map(c => (
          <div key={c.label} className="bg-white border rounded-lg p-3">
            <div className="text-[9px] text-gray-500 uppercase tracking-wide">{c.label}</div>
            <div className="text-xl font-bold mt-0.5">{c.zar}</div>
            {c.usd && <div className="text-sm text-gray-500">{c.usd}</div>}
            <div className="text-[10px] text-gray-400">{c.sub}</div>
          </div>
        ))}
      </div>

      {/* API Status */}
      {apiStatus && (
        <div className="bg-white border rounded-lg p-4 mb-6">
          <h2 className="font-bold text-sm mb-3">API Status</h2>
          <div className="grid grid-cols-3 gap-3">
            {Object.entries(apiStatus).map(([key, val]) => {
              const v = val as A;
              const color = v.status === "ok" ? "border-green-300 bg-green-50" : v.status === "down" ? "border-red-300 bg-red-50" : v.status === "configured" ? "border-blue-200 bg-blue-50" : "border-gray-200 bg-gray-50";
              const dot = v.status === "ok" ? "bg-green-500" : v.status === "down" ? "bg-red-500" : v.status === "configured" ? "bg-blue-400" : "bg-gray-300";
              return (
                <div key={key} className={`border rounded p-3 ${color}`}>
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${dot}`} />
                    <span className="font-bold text-sm capitalize">{key.replace(/_/g, " ")}</span>
                  </div>
                  <div className="text-xs text-gray-600 mt-1">{v.message}</div>
                  {v.action && <a href={v.action} target="_blank" rel="noreferrer" className="text-[10px] text-blue-600 hover:underline mt-1 block">Fix this &rarr;</a>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Data size breakdown */}
      <div className="bg-white border rounded-lg p-4 mb-6">
        <h2 className="font-bold text-sm mb-3">Data Storage</h2>
        <div className="grid grid-cols-4 gap-4">
          {[
            { label: "Properties Table", val: fBytes(data_size.properties_table_bytes), count: data_size.total_properties + " rows" },
            { label: "Images Table", val: fBytes(data_size.images_table_bytes), count: data_size.total_images + " photos" },
            { label: "Reports Table", val: fBytes(data_size.reports_table_bytes), count: data_size.total_reports + " reports" },
            { label: "Image URL Data", val: fBytes(data_size.total_image_url_chars), count: "URL storage" },
          ].map(c => (
            <div key={c.label} className="bg-gray-50 rounded p-3">
              <div className="text-xs text-gray-500">{c.label}</div>
              <div className="text-lg font-bold">{c.val}</div>
              <div className="text-[10px] text-gray-400">{c.count}</div>
            </div>
          ))}
        </div>
      </div>

      {/* WhatsApp / Twilio */}
      {whatsapp && (
        <div className="bg-white border rounded-lg p-4 mb-6">
          <h2 className="font-bold text-sm mb-3">WhatsApp / Twilio</h2>
          <div className="grid grid-cols-5 gap-3 mb-4">
            {[
              { label: "Total Messages", val: whatsapp.total_messages, sub: `${whatsapp.outbound} sent · ${whatsapp.inbound} received` },
              { label: "Twilio Cost", val: fZAR(whatsapp.total_cost_zar), sub: fUSD(whatsapp.total_cost_usd) },
              { label: "Today", val: `${whatsapp.today?.outbound || 0} sent`, sub: `${whatsapp.today?.inbound || 0} received` },
              { label: "This Month", val: `${whatsapp.month?.outbound || 0} sent`, sub: `${whatsapp.month?.inbound || 0} received` },
              { label: "Unique Users", val: whatsapp.unique_users, sub: whatsapp.with_media ? `${whatsapp.with_media} with media` : "" },
            ].map(c => (
              <div key={c.label} className="bg-gray-50 rounded p-3">
                <div className="text-[9px] text-gray-500 uppercase tracking-wide">{c.label}</div>
                <div className="text-lg font-bold mt-0.5">{c.val}</div>
                <div className="text-[10px] text-gray-400">{c.sub}</div>
              </div>
            ))}
          </div>

          {/* Daily WhatsApp chart */}
          {whatsapp.daily?.length > 0 && (
            <div className="mb-4">
              <div className="text-xs text-gray-500 mb-1">Daily messages (30 days)</div>
              <div className="flex items-end gap-1 h-16">
                {(() => {
                  const byDay: Record<string, { inbound: number; outbound: number }> = {};
                  for (const d of whatsapp.daily) {
                    if (!byDay[d.day]) byDay[d.day] = { inbound: 0, outbound: 0 };
                    byDay[d.day][d.direction as "inbound" | "outbound"] += Number(d.cnt);
                  }
                  const days = Object.entries(byDay);
                  const max = Math.max(...days.map(d => d[1].inbound + d[1].outbound), 1);
                  return days.map(([day, val], i) => (
                    <div key={i} className="flex-1 flex flex-col justify-end" title={`${day}: ${val.outbound} sent, ${val.inbound} received`}>
                      <div className="bg-green-500 rounded-t" style={{ height: `${(val.outbound / max) * 100}%`, minHeight: val.outbound > 0 ? "2px" : "0" }} />
                      <div className="bg-blue-400" style={{ height: `${(val.inbound / max) * 100}%`, minHeight: val.inbound > 0 ? "2px" : "0" }} />
                    </div>
                  ));
                })()}
              </div>
              <div className="flex gap-3 mt-1 text-[9px] text-gray-400">
                <span><span className="inline-block w-2 h-2 bg-green-500 rounded mr-0.5" /> Sent</span>
                <span><span className="inline-block w-2 h-2 bg-blue-400 rounded mr-0.5" /> Received</span>
              </div>
            </div>
          )}

          {/* Recent messages */}
          {whatsapp.recent?.length > 0 && (
            <>
              <div className="text-xs text-gray-500 mb-1">Recent messages</div>
              <table className="w-full text-xs">
                <thead><tr className="text-left text-gray-500"><th className="pb-1">Time</th><th className="pb-1">Dir</th><th className="pb-1">Phone</th><th className="pb-1">Message</th></tr></thead>
                <tbody>
                  {whatsapp.recent.map((m: A, i: number) => (
                    <tr key={i} className="border-t">
                      <td className="py-1 text-gray-400 whitespace-nowrap">{formatDate(m.created_at)}</td>
                      <td className="py-1"><span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${m.direction === "outbound" ? "bg-green-100 text-green-700" : "bg-blue-100 text-blue-700"}`}>{m.direction === "outbound" ? "OUT" : "IN"}</span></td>
                      <td className="py-1 font-mono text-gray-500">{m.phone_number?.replace("+27", "0")}</td>
                      <td className="py-1 text-gray-600 max-w-md truncate">{m.body?.substring(0, 80) || (m.media_url ? "[PDF]" : "—")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          <div className="text-[9px] text-gray-400 mt-3">Twilio pricing: ~$0.005/outbound message (WhatsApp Business). Inbound messages are free.</div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-6 mb-6">
        {/* Cost by service */}
        <div className="bg-white border rounded-lg p-4">
          <h2 className="font-bold text-sm mb-3">Cost by Service</h2>
          {by_service.length > 0 ? (
            <table className="w-full text-sm">
              <thead><tr className="text-left text-gray-500 text-xs"><th className="pb-2">Service</th><th className="pb-2 text-right">Calls</th><th className="pb-2 text-right">ZAR</th><th className="pb-2 text-right">USD</th></tr></thead>
              <tbody>
                {by_service.map((s: A, i: number) => (
                  <tr key={i} className="border-t">
                    <td className="py-1.5 capitalize font-medium">{s.service}</td>
                    <td className="py-1.5 text-right font-mono text-gray-500">{s.calls}</td>
                    <td className="py-1.5 text-right font-mono font-bold">{fZAR(s.total_zar)}</td>
                    <td className="py-1.5 text-right font-mono text-gray-400 text-xs">{fUSD(s.total_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="text-gray-400 text-sm">No API calls yet</p>}
        </div>

        {/* Cost by endpoint */}
        <div className="bg-white border rounded-lg p-4">
          <h2 className="font-bold text-sm mb-3">Cost by Endpoint</h2>
          {by_endpoint.length > 0 ? (
            <table className="w-full text-sm">
              <thead><tr className="text-left text-gray-500 text-xs"><th className="pb-2">Endpoint</th><th className="pb-2 text-right">Calls</th><th className="pb-2 text-right">Cost</th></tr></thead>
              <tbody>
                {by_endpoint.map((s: A, i: number) => (
                  <tr key={i} className="border-t">
                    <td className="py-1.5 font-mono text-xs">{s.service}/{s.endpoint}</td>
                    <td className="py-1.5 text-right font-mono text-gray-500">{s.calls}</td>
                    <td className="py-1.5 text-right font-mono font-bold">{fZAR(s.total_zar)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="text-gray-400 text-sm">No data</p>}
        </div>
      </div>

      {/* Cost per property */}
      <div className="bg-white border rounded-lg p-4 mb-6">
        <h2 className="font-bold text-sm mb-3">Cost &amp; Data per Property</h2>
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="bg-[#0D1B2A] text-white text-left">
              <th className="px-2 py-1.5">Property</th>
              <th className="px-2 py-1.5 text-right">Photos</th>
              <th className="px-2 py-1.5 text-right">Analysed</th>
              <th className="px-2 py-1.5 text-right">Findings</th>
              <th className="px-2 py-1.5 text-right">Vision</th>
              <th className="px-2 py-1.5 text-right">Report</th>
              <th className="px-2 py-1.5 text-right">Google</th>
              <th className="px-2 py-1.5 text-right">Total (ZAR)</th>
              <th className="px-2 py-1.5 text-right">Total (USD)</th>
              <th className="px-2 py-1.5 text-right">Data</th>
            </tr>
          </thead>
          <tbody>
            {by_property.map((p: A) => (
              <tr key={p.id} className="border-b hover:bg-gray-50 cursor-pointer" onClick={() => router.push(`/admin/data/inspect/${p.id}`)}>
                <td className="px-2 py-1.5">
                  <div className="font-medium max-w-xs truncate">{p.street_address || p.address_raw}</div>
                  <div className="text-[9px] text-gray-400">{p.suburb}, {p.city}</div>
                </td>
                <td className="px-2 py-1.5 text-right font-mono">{p.photo_count}</td>
                <td className="px-2 py-1.5 text-right font-mono">{p.analysed_photos}</td>
                <td className="px-2 py-1.5 text-right font-mono">{p.finding_count}</td>
                <td className="px-2 py-1.5 text-right font-mono text-orange-600">{Number(p.vision_cost_zar) > 0 ? fZAR(p.vision_cost_zar) : "—"}</td>
                <td className="px-2 py-1.5 text-right font-mono text-blue-600">{Number(p.synthesis_cost_zar) > 0 ? fZAR(p.synthesis_cost_zar) : "—"}</td>
                <td className="px-2 py-1.5 text-right font-mono text-green-600">{Number(p.google_cost_zar) > 0 ? fZAR(p.google_cost_zar) : "—"}</td>
                <td className="px-2 py-1.5 text-right font-mono font-bold">{Number(p.api_cost_zar) > 0 ? fZAR(p.api_cost_zar) : "—"}</td>
                <td className="px-2 py-1.5 text-right font-mono text-gray-500">{Number(p.api_cost_usd) > 0 ? fUSD(p.api_cost_usd) : "—"}</td>
                <td className="px-2 py-1.5 text-right font-mono text-gray-400">{fBytes(p.property_row_bytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {by_property.length === 0 && <p className="text-gray-400 text-sm mt-2">No properties with tracked costs yet</p>}
      </div>

      {/* Daily costs */}
      {daily.length > 0 && (
        <div className="bg-white border rounded-lg p-4 mb-6">
          <h2 className="font-bold text-sm mb-3">Daily Costs (Last 30 Days)</h2>
          <div className="flex items-end gap-1 h-24">
            {(() => {
              const byDay: Record<string, number> = {};
              for (const d of daily) byDay[d.day] = (byDay[d.day] || 0) + Number(d.total_zar);
              const days = Object.entries(byDay);
              const max = Math.max(...days.map(d => d[1]), 0.01);
              return days.map(([day, val], i) => (
                <div key={i} className="flex-1 bg-[#0D1B2A] rounded-t" style={{ height: `${(val / max) * 100}%`, minHeight: val > 0 ? "2px" : "0" }} title={`${day}: R${val.toFixed(2)}`} />
              ));
            })()}
          </div>
        </div>
      )}

      {/* Pricing reference */}
      <div className="bg-[#0D1B2A] text-white rounded-lg p-4 mb-6">
        <h2 className="font-bold text-sm mb-3">API Pricing Reference</h2>
        <div className="grid grid-cols-3 gap-4 text-xs">
          <div>
            <div className="text-gray-400 font-bold mb-1">Anthropic Claude</div>
            <div>Haiku: $0.25/M input, $1.25/M output</div>
            <div>Sonnet: $3/M input, $15/M output</div>
            <div>Opus: $15/M input, $75/M output</div>
            <div className="text-gray-400 mt-1">~2K tokens per vision analysis</div>
            <div className="text-gray-400">~4K tokens per report synthesis</div>
          </div>
          <div>
            <div className="text-gray-400 font-bold mb-1">Google Maps</div>
            <div>Geocoding: $0.005/request (R0.09)</div>
            <div>Street View: $0.007/request (R0.13)</div>
            <div>Static Maps: $0.002/request (R0.04)</div>
            <div className="text-gray-400 mt-1">40K free geocodes/month</div>
          </div>
          <div>
            <div className="text-gray-400 font-bold mb-1">Twilio WhatsApp</div>
            <div>Outbound message: ~$0.005 (R0.09)</div>
            <div>Inbound message: free</div>
            <div>Media (PDF): ~$0.005 (R0.09)</div>
            <div className="text-gray-400 mt-1">~4 messages per report flow</div>
            <div className="text-gray-400">WhatsApp cost per report: ~$0.02 (R0.37)</div>
          </div>
        </div>
        <div className="text-[9px] text-gray-500 mt-2">Exchange rate: $1 = R{ZAR_RATE}. Prices as of April 2026. Actual costs depend on token usage.</div>
      </div>

      {/* Recent calls */}
      <div className="bg-white border rounded-lg p-4">
        <h2 className="font-bold text-sm mb-3">Recent API Calls</h2>
        <table className="w-full text-xs">
          <thead><tr className="text-left text-gray-500"><th className="pb-2">Time</th><th className="pb-2">Service</th><th className="pb-2">Endpoint</th><th className="pb-2">Property</th><th className="pb-2 text-right">Tokens</th><th className="pb-2 text-right">ZAR</th><th className="pb-2 text-right">USD</th></tr></thead>
          <tbody>
            {recent.map((r: A, i: number) => (
              <tr key={i} className="border-t">
                <td className="py-1 text-gray-400">{formatDate(r.created_at)}</td>
                <td className="py-1 capitalize">{r.service}</td>
                <td className="py-1 font-mono">{r.endpoint}</td>
                <td className="py-1 text-gray-500 max-w-xs truncate">{r.address_raw || r.suburb || "—"}</td>
                <td className="py-1 text-right font-mono text-gray-400">{r.input_tokens ? `${r.input_tokens}/${r.output_tokens}` : "—"}</td>
                <td className="py-1 text-right font-mono font-bold">{fZAR(r.cost_zar)}</td>
                <td className="py-1 text-right font-mono text-gray-500">{fUSD(r.cost_usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {recent.length === 0 && <p className="text-gray-400 text-sm">No API calls recorded yet. Costs are tracked automatically when you analyse photos, generate reports, or geocode.</p>}
      </div>
    </div>
  );
}
