"use client";
import { useEffect, useState } from "react";
import { formatZAR } from "@/lib/format";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type A = Record<string, any>;

export default function MoneyPage() {
  const [data, setData] = useState<A | null>(null);

  useEffect(() => {
    fetch("/api/analytics").then(r => r.json()).then(setData);
  }, []);

  if (!data) return <p className="text-gray-500">Loading...</p>;

  const maxDaily = Math.max(...data.daily_orders.map((d: A) => Number(d.c)), 1);

  return (
    <div>
      <div className="flex justify-between items-start mb-6">
        <div>
          <h1 className="text-2xl font-bold">Money</h1>
          <p className="text-sm text-gray-500">Revenue, payments, and costs</p>
        </div>
        <a href="https://payf.st/zcg1y" target="_blank" rel="noreferrer"
          className="px-4 py-2 bg-[#00457C] text-white text-sm rounded font-bold hover:bg-[#003366]">
          PayFast Dashboard
        </a>
      </div>

      {/* Revenue cards */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        {[
          { label: "Revenue Today", value: formatZAR(data.revenue_today), sub: `${data.orders_today} orders` },
          { label: "Revenue This Month", value: formatZAR(data.revenue_month), sub: `${data.orders_month} orders` },
          { label: "B2B Revenue / Month", value: formatZAR(data.b2b_revenue_month), sub: "API client billing" },
          { label: "Resale Rate", value: `${data.resale_pct}%`, sub: "reports sold more than once" },
        ].map(c => (
          <div key={c.label} className="bg-white border rounded-lg p-4">
            <div className="text-xs text-gray-500 uppercase tracking-wide">{c.label}</div>
            <div className="text-2xl font-bold mt-1">{c.value}</div>
            <div className="text-[10px] text-gray-400">{c.sub}</div>
          </div>
        ))}
      </div>

      {/* Revenue per day chart */}
      <div className="bg-white border rounded-lg p-4 mb-6">
        <h2 className="font-bold text-sm mb-3">Orders Per Day (Last 30 Days)</h2>
        <div className="flex items-end gap-1 h-32">
          {data.daily_orders.map((d: A, i: number) => (
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

      {/* Payment integration */}
      <div className="bg-white border rounded-lg p-4 mb-6">
        <h2 className="font-bold text-sm mb-2">Payment Integration</h2>
        <div className="grid grid-cols-2 gap-4">
          <div className="border rounded p-3">
            <div className="text-xs font-bold mb-1">PayFast</div>
            <div className="text-xs text-gray-500 mb-2">Consumer payments for property reports (R149 per report)</div>
            <a href="https://payf.st/zcg1y" target="_blank" rel="noreferrer" className="text-xs text-blue-600 hover:underline">Open PayFast dashboard</a>
            <div className="mt-2 text-[10px] text-gray-400">
              Webhook: POST /api/payfast/notify<br />
              Return URL: /report/[id]/thank-you<br />
              Cancel URL: /report/[id]
            </div>
          </div>
          <div className="border rounded p-3">
            <div className="text-xs font-bold mb-1">B2B Billing</div>
            <div className="text-xs text-gray-500 mb-2">API client billing — per-query pricing by tier</div>
            <a href="/admin/api" className="text-xs text-blue-600 hover:underline">Manage API clients</a>
            <div className="mt-2 text-[10px] text-gray-400">
              Revenue this month: {formatZAR(data.b2b_revenue_month)}<br />
              <a href="/admin/billing" className="text-blue-600 hover:underline">View detailed costs</a>
            </div>
          </div>
        </div>
      </div>

      {/* Price metrics */}
      <div className="bg-white border rounded-lg p-4">
        <h2 className="font-bold text-sm mb-2">Pricing</h2>
        <div className="grid grid-cols-3 gap-4 text-xs">
          <div className="bg-gray-50 rounded p-3">
            <div className="text-gray-500 font-bold mb-1">Consumer Report</div>
            <div className="text-2xl font-bold">R149</div>
            <div className="text-[10px] text-gray-400 mt-1">Per property report. Includes vision analysis, risk scoring, negotiation intel.</div>
          </div>
          <div className="bg-gray-50 rounded p-3">
            <div className="text-gray-500 font-bold mb-1">Resale</div>
            <div className="text-2xl font-bold">R99</div>
            <div className="text-[10px] text-gray-400 mt-1">Discounted price for previously generated reports.</div>
          </div>
          <div className="bg-gray-50 rounded p-3">
            <div className="text-gray-500 font-bold mb-1">Generation Cost</div>
            <div className="text-2xl font-bold">~R5–R15</div>
            <div className="text-[10px] text-gray-400 mt-1">API costs per report (Claude + Google). See <a href="/admin/billing" className="text-blue-600 hover:underline">Billing</a> for details.</div>
          </div>
        </div>
      </div>
    </div>
  );
}
