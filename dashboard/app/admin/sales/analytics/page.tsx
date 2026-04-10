"use client";
import { useEffect, useState } from "react";
import { formatZAR } from "@/lib/format";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type A = Record<string, any>;

export default function MoneyPage() {
  const [data, setData] = useState<A | null>(null);
  const [billing, setBilling] = useState<A | null>(null);
  const [price, setPrice] = useState<number>(169);
  const [priceInput, setPriceInput] = useState<string>("169");
  const [priceSaving, setPriceSaving] = useState(false);
  const [priceMsg, setPriceMsg] = useState<string | null>(null);
  const [paymentEnabled, setPaymentEnabled] = useState(true);
  const [toggling, setToggling] = useState(false);

  useEffect(() => {
    fetch("/api/analytics").then(r => r.json()).then(setData);
    fetch("/api/billing").then(r => r.json()).then(setBilling).catch(() => {});
    fetch("/api/settings", { cache: "no-store" }).then(r => r.json()).then(d => { setPrice(d.report_price); setPriceInput(String(d.report_price)); setPaymentEnabled(d.payment_enabled !== false); }).catch(() => {});
  }, []);

  async function savePrice() {
    const newPrice = parseInt(priceInput);
    if (isNaN(newPrice) || newPrice < 0) return;
    setPriceSaving(true);
    await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ report_price: newPrice }) });
    setPrice(newPrice);
    setPriceMsg("Price updated");
    setPriceSaving(false);
    setTimeout(() => setPriceMsg(null), 3000);
  }

  if (!data) return <p className="text-gray-500">Loading...</p>;

  const maxDaily = Math.max(...data.daily_orders.map((d: A) => Number(d.c)), 1);

  return (
    <div>
      <div className="flex justify-between items-start mb-6">
        <div>
          <h1 className="text-2xl font-bold">Revenue</h1>
          <p className="text-sm text-gray-500">Revenue, payments, and costs</p>
        </div>
        <a href="https://www.payfast.co.za/dashboard" target="_blank" rel="noreferrer"
          className="px-4 py-2 bg-[#00457C] text-white text-sm rounded font-bold hover:bg-[#003366]">
          PayFast Dashboard
        </a>
      </div>

      {/* Payment toggle */}
      <div className={`border rounded-lg p-4 mb-6 flex items-center justify-between ${paymentEnabled ? "bg-green-50 border-green-200" : "bg-amber-50 border-amber-200"}`}>
        <div>
          <div className="flex items-center gap-2">
            <span className={`w-3 h-3 rounded-full ${paymentEnabled ? "bg-green-500" : "bg-amber-500 animate-pulse"}`} />
            <span className="font-bold text-sm">{paymentEnabled ? "Payments Active" : "Income Paused — Reports are FREE"}</span>
          </div>
          <p className="text-[10px] text-gray-500 mt-0.5">{paymentEnabled ? "Users pay via PayFast before receiving reports." : "Users get reports immediately without paying. Turn on when ready to charge."}</p>
        </div>
        <button
          onClick={async () => {
            setToggling(true);
            const newState = !paymentEnabled;
            await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ payment_enabled: newState }) });
            setPaymentEnabled(newState);
            setToggling(false);
          }}
          disabled={toggling}
          className={`px-5 py-2 rounded text-sm font-bold ${paymentEnabled ? "bg-amber-500 text-white hover:bg-amber-600" : "bg-green-600 text-white hover:bg-green-700"} disabled:opacity-50`}
        >
          {toggling ? "..." : paymentEnabled ? "Pause Income" : "Resume Income"}
        </button>
      </div>

      {/* Revenue cards */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        {[
          { label: "Revenue Today", value: formatZAR(data.revenue_today), sub: data.orders_today_paid > 0 ? `${data.orders_today_paid} paid` : `${data.orders_today} reports${data.orders_today_free ? ` (${data.orders_today_free} free)` : ""}` },
          { label: "Revenue This Month", value: formatZAR(data.revenue_month), sub: data.orders_month_paid > 0 ? `${data.orders_month_paid} paid, ${data.orders_month_free || 0} free` : `${data.orders_month} reports${data.orders_month_free ? ` (${data.orders_month_free} free)` : ""}` },
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
            <div className="text-xs text-gray-500 mb-2">Consumer payments for property reports (R{price} per report)</div>
            <a href="https://www.payfast.co.za/dashboard" target="_blank" rel="noreferrer" className="text-xs text-blue-600 hover:underline">Open PayFast dashboard</a>
            <div className="mt-2 text-[10px] text-gray-400">
              Webhook: POST /webhook/payfast<br />
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
            <div className="flex items-center gap-1 mt-1">
              <span className="text-lg font-bold text-gray-400">R</span>
              <input type="number" value={priceInput} onChange={e => setPriceInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") savePrice(); }}
                className="text-2xl font-bold w-20 border rounded px-1" min={0} max={10000} />
              <button onClick={savePrice} disabled={priceSaving || parseInt(priceInput) === price}
                className="px-2 py-1 bg-[#0D1B2A] text-white rounded text-[10px] font-semibold hover:bg-gray-800 disabled:opacity-30">
                {priceSaving ? "..." : "Save"}
              </button>
            </div>
            {priceMsg && <div className="text-[10px] text-green-600 mt-1">{priceMsg}</div>}
            <div className="text-[10px] text-gray-400 mt-1">Changes apply to WhatsApp and PayFast instantly.</div>
          </div>
          <div className="bg-gray-50 rounded p-3">
            <div className="text-gray-500 font-bold mb-1">Avg Generation Cost</div>
            <div className="text-2xl font-bold">{billing?.avg_cost?.avg_cost_zar ? `R${Number(billing.avg_cost.avg_cost_zar).toFixed(2)}` : "—"}</div>
            <div className="text-[10px] text-gray-400 mt-1">Actual API cost per report (Claude + Google). <a href="/admin/billing" className="text-blue-600 hover:underline">See Billing</a></div>
          </div>
          <div className="bg-gray-50 rounded p-3">
            <div className="text-gray-500 font-bold mb-1">Margin per Report</div>
            <div className="text-2xl font-bold text-green-700">{billing?.avg_cost?.avg_cost_zar ? `R${(price - Number(billing.avg_cost.avg_cost_zar)).toFixed(2)}` : "—"}</div>
            <div className="text-[10px] text-gray-400 mt-1">{billing?.avg_cost?.avg_cost_zar ? `${Math.round((1 - Number(billing.avg_cost.avg_cost_zar) / price) * 100)}% margin` : ""} · Max cost: {billing?.avg_cost?.max_cost_zar ? `R${Number(billing.avg_cost.max_cost_zar).toFixed(2)}` : "—"}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
