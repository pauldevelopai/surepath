"use client";
import { useEffect, useState } from "react";
import { formatZAR } from "@/lib/format";

interface Analytics {
  orders_today: number;
  orders_month: number;
  revenue_today: number;
  revenue_month: number;
  b2b_revenue_month: number;
  resale_pct: number;
  new_properties_week: number;
  daily_orders: { day: string; c: number }[];
  top_suburbs: { suburb: string; c: number }[];
  decisions: { decision: string; c: number }[];
  defects: { category: string; c: number }[];
}

const DECISION_COLORS: Record<string, string> = {
  BUY: "#27AE60", NEGOTIATE: "#F1C40F", INSPECT_FIRST: "#E67E22", WALK_AWAY: "#E63946",
};

export default function AnalyticsPage() {
  const [data, setData] = useState<Analytics | null>(null);

  useEffect(() => {
    fetch("/api/analytics").then(r => r.json()).then(setData);
  }, []);

  if (!data) return <p className="text-gray-500">Loading analytics...</p>;

  const totalDecisions = data.decisions.reduce((s, d) => s + Number(d.c), 0) || 1;
  const maxDaily = Math.max(...data.daily_orders.map(d => Number(d.c)), 1);

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Analytics</h1>

      {/* Cards */}
      <div className="grid grid-cols-4 gap-4 mb-8">
        {[
          { label: "Orders Today", value: data.orders_today },
          { label: "Orders This Month", value: data.orders_month },
          { label: "Revenue Today", value: formatZAR(data.revenue_today) },
          { label: "Revenue This Month", value: formatZAR(data.revenue_month) },
          { label: "B2B Revenue/Month", value: formatZAR(data.b2b_revenue_month) },
          { label: "Resale Rate", value: `${data.resale_pct}%` },
          { label: "New Properties/Week", value: data.new_properties_week },
        ].map((card) => (
          <div key={card.label} className="bg-white border rounded-lg p-4 shadow-sm">
            <div className="text-xs text-gray-500 uppercase tracking-wide">{card.label}</div>
            <div className="text-2xl font-bold mt-1">{String(card.value)}</div>
          </div>
        ))}
      </div>

      {/* Bar chart: Orders per day */}
      <div className="bg-white border rounded-lg p-4 shadow-sm mb-8">
        <h2 className="font-bold mb-3">Orders Per Day (Last 30 Days)</h2>
        <div className="flex items-end gap-1 h-32">
          {data.daily_orders.map((d, i) => (
            <div key={i} className="flex-1 flex flex-col items-center">
              <div className="w-full bg-[#0D1B2A] rounded-t transition-all" style={{ height: `${(Number(d.c) / maxDaily) * 100}%`, minHeight: d.c > 0 ? "4px" : "0" }} title={`${d.day}: ${d.c}`} />
            </div>
          ))}
        </div>
        <div className="flex justify-between text-xs text-gray-400 mt-1">
          <span>{data.daily_orders[0]?.day?.slice(5) || ""}</span>
          <span>{data.daily_orders[data.daily_orders.length - 1]?.day?.slice(5) || ""}</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-6">
        {/* Top suburbs */}
        <div className="bg-white border rounded-lg p-4 shadow-sm">
          <h2 className="font-bold mb-3">Top 10 Suburbs</h2>
          <table className="w-full text-sm">
            <tbody>
              {data.top_suburbs.map((s, i) => (
                <tr key={i} className="border-b">
                  <td className="py-1.5">{s.suburb}</td>
                  <td className="py-1.5 text-right font-mono">{s.c}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.top_suburbs.length === 0 && <p className="text-gray-400 text-sm">No data</p>}
        </div>

        {/* Decision distribution — pie chart via CSS */}
        <div className="bg-white border rounded-lg p-4 shadow-sm">
          <h2 className="font-bold mb-3">Decision Distribution</h2>
          <div className="flex gap-6 items-center">
            <div className="relative w-32 h-32">
              <svg viewBox="0 0 36 36" className="w-32 h-32">
                {(() => {
                  let offset = 0;
                  return data.decisions.map((d, i) => {
                    const pct = (Number(d.c) / totalDecisions) * 100;
                    const dash = `${pct} ${100 - pct}`;
                    const el = (
                      <circle
                        key={i}
                        cx="18" cy="18" r="15.915"
                        fill="none"
                        stroke={DECISION_COLORS[d.decision] || "#999"}
                        strokeWidth="3.5"
                        strokeDasharray={dash}
                        strokeDashoffset={String(-offset)}
                        className="transition-all"
                      />
                    );
                    offset += pct;
                    return el;
                  });
                })()}
              </svg>
            </div>
            <div className="space-y-2">
              {data.decisions.map((d, i) => (
                <div key={i} className="flex items-center gap-2 text-sm">
                  <div className="w-3 h-3 rounded-full" style={{ background: DECISION_COLORS[d.decision] || "#999" }} />
                  <span>{d.decision}</span>
                  <span className="text-gray-500">({d.c})</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Common defects */}
      <div className="bg-white border rounded-lg p-4 shadow-sm mt-6">
        <h2 className="font-bold mb-3">Most Common Defect Flags</h2>
        <table className="w-full text-sm">
          <thead><tr className="text-left text-gray-500"><th className="pb-2">Category</th><th className="pb-2 text-right">Count</th><th className="pb-2 w-48"></th></tr></thead>
          <tbody>
            {data.defects.map((d, i) => {
              const maxDefect = Number(data.defects[0]?.c) || 1;
              return (
                <tr key={i} className="border-b">
                  <td className="py-1.5 capitalize">{d.category}</td>
                  <td className="py-1.5 text-right font-mono">{d.c}</td>
                  <td className="py-1.5 pl-4">
                    <div className="w-full bg-gray-200 rounded-full h-2">
                      <div className="h-2 rounded-full bg-[#E63946]" style={{ width: `${(Number(d.c) / maxDefect) * 100}%` }} />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {data.defects.length === 0 && <p className="text-gray-400 text-sm">No defect data</p>}
      </div>
    </div>
  );
}
