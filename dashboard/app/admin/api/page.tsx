"use client";
import { useEffect, useState } from "react";
import { formatZAR } from "@/lib/format";

interface Client {
  id: number;
  company_name: string;
  tier: string;
  api_key: string;
  rate_limit_per_day: number;
  active: boolean;
  queries_this_month: number;
  revenue_this_month: number;
}

interface ClientDetail {
  client: Client;
  usage_by_endpoint: { endpoint: string; queries: number; cache_hits: number; revenue: number }[];
  daily_usage: { day: string; queries: number }[];
}

const ENDPOINTS = [
  {
    method: "POST", path: "/api/v1/risk/insurance",
    input: '{ "address": "12 Kloof St, Gardens, Cape Town" }',
    output: "insurance_risk_score, insurance_flags[], maintenance_cost_estimate, asbestos_risk, erf_number",
    segment: "Insurance",
  },
  {
    method: "POST", path: "/api/v1/risk/crime",
    input: '{ "address": "...", "radius_km": 2 }',
    output: "crime_risk_score, suburb, incident_breakdown, saps_data_period",
    segment: "Security",
  },
  {
    method: "POST", path: "/api/v1/solar/suitability",
    input: '{ "address": "..." }',
    output: "solar_suitability_score, solar_installed, roof_material, roof_orientation, recommended_system_size_kw",
    segment: "Solar",
  },
  {
    method: "POST", path: "/api/v1/leads/trades",
    input: '{ "suburb": "Gardens", "city": "Cape Town", "trade_type": "electrical", "min_severity": "MEDIUM" }',
    output: "count, properties[]: address, erf_number, trade_flags[], estimated_job_value",
    segment: "Trades",
  },
  {
    method: "POST", path: "/api/v1/leads/solar",
    input: '{ "suburb": "...", "city": "...", "filters": { "no_solar": true, "min_roof_score": 6 } }',
    output: "count, properties[]: address, solar_suitability_score, roof_material, construction_era",
    segment: "Solar",
  },
  {
    method: "GET", path: "/api/v1/heat-map/crime?suburb=Gardens&city=Cape+Town",
    input: "Query params: suburb, city",
    output: "incident_counts, total_incidents, coverage_period, last_updated",
    segment: "Security",
  },
  {
    method: "POST", path: "/api/v1/report/full",
    input: '{ "address": "...", "asking_price": 2500000 }',
    output: "Complete property report — all fields including B2B scores. Billed at 5x rate.",
    segment: "Enterprise",
  },
];

export default function ApiPage() {
  const [tab, setTab] = useState<"clients" | "docs">("docs");
  const [clients, setClients] = useState<Client[]>([]);
  const [selected, setSelected] = useState<ClientDetail | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ company_name: "", tier: "consumer", rate_limit_per_day: "1000", price_per_query_zar: "0.50" });
  const [newKey, setNewKey] = useState<string | null>(null);

  useEffect(() => {
    if (tab === "clients") fetch("/api/b2b").then(r => r.json()).then(setClients);
  }, [tab]);

  async function viewClient(id: number) {
    const res = await fetch(`/api/b2b/${id}`);
    setSelected(await res.json());
  }

  async function addClient(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch("/api/b2b", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...form, rate_limit_per_day: parseInt(form.rate_limit_per_day), price_per_query_zar: parseFloat(form.price_per_query_zar) }),
    });
    const json = await res.json();
    setNewKey(json.api_key);
    setShowForm(false);
    fetch("/api/b2b").then(r => r.json()).then(setClients);
  }

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">B2B API</h1>
      <p className="text-sm text-gray-500 mb-4">Manage API clients and view endpoint documentation</p>

      {/* Tabs */}
      <div className="flex border-b mb-6">
        {(["docs", "clients"] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 capitalize ${tab === t ? "border-[#E63946] text-[#0D1B2A]" : "border-transparent text-gray-400"}`}>
            {t === "docs" ? "Endpoint Docs" : "API Clients"}
          </button>
        ))}
      </div>

      {/* DOCS TAB */}
      {tab === "docs" && (
        <div>
          <div className="bg-[#0D1B2A] text-white rounded p-4 mb-6 text-sm">
            <div className="font-bold mb-1">Authentication</div>
            <p className="text-gray-300 mb-2">All requests require: <code className="bg-white/10 px-1.5 py-0.5 rounded">Authorization: Bearer YOUR_API_KEY</code></p>
            <div className="font-bold mb-1 mt-3">Rate Limiting</div>
            <p className="text-gray-300 mb-2">Per-client daily limit. Returns <code className="bg-white/10 px-1.5 py-0.5 rounded">429</code> when exceeded.</p>
            <div className="font-bold mb-1 mt-3">Caching</div>
            <p className="text-gray-300">Address-based endpoints return cached reports if &lt;90 days old. Fresh reports generated automatically if no cache hit.</p>
          </div>

          <div className="space-y-4">
            {ENDPOINTS.map((ep, i) => (
              <div key={i} className="bg-white border rounded overflow-hidden">
                <div className="flex items-center gap-2 px-4 py-2 bg-gray-50 border-b">
                  <span className={`px-2 py-0.5 rounded text-xs font-bold ${ep.method === "GET" ? "bg-green-100 text-green-800" : "bg-blue-100 text-blue-800"}`}>{ep.method}</span>
                  <code className="text-sm font-mono">{ep.path}</code>
                  <span className="ml-auto text-xs bg-gray-200 px-2 py-0.5 rounded">{ep.segment}</span>
                </div>
                <div className="px-4 py-3 text-sm">
                  <div className="mb-2">
                    <span className="text-xs text-gray-500 uppercase font-bold">Input</span>
                    <pre className="bg-gray-50 rounded p-2 mt-1 text-xs font-mono overflow-x-auto">{ep.input}</pre>
                  </div>
                  <div>
                    <span className="text-xs text-gray-500 uppercase font-bold">Output</span>
                    <p className="text-xs text-gray-600 mt-1">{ep.output}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="bg-gray-50 border rounded p-4 mt-6 text-sm">
            <div className="font-bold mb-2">Error Responses</div>
            <table className="w-full text-xs">
              <tbody>
                <tr className="border-b"><td className="py-1 font-mono">401</td><td className="py-1"><code>{`{ "error": "Invalid API key", "code": "AUTH_INVALID" }`}</code></td></tr>
                <tr className="border-b"><td className="py-1 font-mono">429</td><td className="py-1"><code>{`{ "error": "Rate limit exceeded", "code": "RATE_LIMIT" }`}</code></td></tr>
                <tr className="border-b"><td className="py-1 font-mono">400</td><td className="py-1"><code>{`{ "error": "address is required", "code": "MISSING_FIELD" }`}</code></td></tr>
                <tr><td className="py-1 font-mono">500</td><td className="py-1"><code>{`{ "error": "Internal error", "code": "SERVER_ERROR" }`}</code></td></tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* CLIENTS TAB */}
      {tab === "clients" && (
        <div>
          <button onClick={() => setShowForm(!showForm)} className="bg-[#E63946] text-white px-4 py-2 rounded text-sm font-semibold mb-4">
            Add New Client
          </button>

          {newKey && (
            <div className="bg-green-50 border border-green-200 p-4 rounded mb-4">
              <p className="text-sm font-bold text-green-800">API key created:</p>
              <code className="text-xs break-all bg-white p-2 block mt-1 rounded border">{newKey}</code>
              <p className="text-xs text-gray-500 mt-1">Copy this now — it won&apos;t be shown again.</p>
            </div>
          )}

          {showForm && (
            <form onSubmit={addClient} className="bg-gray-50 p-4 rounded mb-4 grid grid-cols-2 gap-3">
              <input className="border rounded px-3 py-2 text-sm col-span-2" placeholder="Company name" value={form.company_name} onChange={e => setForm({ ...form, company_name: e.target.value })} required />
              <select className="border rounded px-3 py-2 text-sm" value={form.tier} onChange={e => setForm({ ...form, tier: e.target.value })}>
                {["consumer", "insurance", "security", "trades", "solar", "enterprise"].map(t => <option key={t} value={t}>{t}</option>)}
              </select>
              <input className="border rounded px-3 py-2 text-sm" placeholder="Rate limit/day" value={form.rate_limit_per_day} onChange={e => setForm({ ...form, rate_limit_per_day: e.target.value })} />
              <input className="border rounded px-3 py-2 text-sm" placeholder="Price per query (ZAR)" value={form.price_per_query_zar} onChange={e => setForm({ ...form, price_per_query_zar: e.target.value })} />
              <button className="bg-[#0D1B2A] text-white px-4 py-2 rounded text-sm">Create</button>
            </form>
          )}

          <table className="w-full text-sm border-collapse mb-6">
            <thead>
              <tr className="bg-[#0D1B2A] text-white text-left">
                <th className="px-3 py-2">Company</th>
                <th className="px-3 py-2">Tier</th>
                <th className="px-3 py-2">Rate Limit</th>
                <th className="px-3 py-2">Active</th>
                <th className="px-3 py-2">Queries/Month</th>
                <th className="px-3 py-2">Revenue/Month</th>
              </tr>
            </thead>
            <tbody>
              {clients.map(c => (
                <tr key={c.id} className="border-b hover:bg-gray-50 cursor-pointer" onClick={() => viewClient(c.id)}>
                  <td className="px-3 py-2 font-medium">{c.company_name}</td>
                  <td className="px-3 py-2"><span className="bg-blue-100 text-blue-800 px-2 py-0.5 rounded text-xs">{c.tier}</span></td>
                  <td className="px-3 py-2">{c.rate_limit_per_day}/day</td>
                  <td className="px-3 py-2">{c.active ? <span className="text-green-600">Active</span> : <span className="text-red-500">Inactive</span>}</td>
                  <td className="px-3 py-2">{c.queries_this_month}</td>
                  <td className="px-3 py-2">{formatZAR(c.revenue_this_month)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {clients.length === 0 && <p className="text-gray-400">No API clients yet.</p>}

          {selected && (
            <div className="bg-gray-50 p-4 rounded">
              <h2 className="font-bold text-lg mb-3">{selected.client.company_name}</h2>
              <h3 className="font-bold text-sm mb-2">Usage by Endpoint</h3>
              <table className="w-full text-sm border-collapse mb-4">
                <thead><tr className="bg-gray-200"><th className="px-2 py-1 text-left">Endpoint</th><th className="px-2 py-1">Queries</th><th className="px-2 py-1">Cache Hits</th><th className="px-2 py-1">Hit Rate</th><th className="px-2 py-1">Revenue</th></tr></thead>
                <tbody>
                  {selected.usage_by_endpoint.map((u, i) => (
                    <tr key={i} className="border-b text-center">
                      <td className="px-2 py-1 font-mono text-xs text-left">{u.endpoint}</td>
                      <td className="px-2 py-1">{u.queries}</td>
                      <td className="px-2 py-1">{u.cache_hits}</td>
                      <td className="px-2 py-1">{u.queries > 0 ? Math.round((u.cache_hits / u.queries) * 100) : 0}%</td>
                      <td className="px-2 py-1">{formatZAR(u.revenue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {selected.usage_by_endpoint.length === 0 && <p className="text-gray-400 text-sm mb-4">No usage this month.</p>}

              <h3 className="font-bold text-sm mb-2">Daily Queries (30 days)</h3>
              <div className="flex items-end gap-1 h-20">
                {selected.daily_usage.map((d, i) => {
                  const max = Math.max(...selected.daily_usage.map(x => x.queries), 1);
                  return <div key={i} className="flex-1 bg-[#0D1B2A] rounded-t" style={{ height: `${(d.queries / max) * 100}%` }} title={`${d.day}: ${d.queries}`} />;
                })}
              </div>
              {selected.daily_usage.length === 0 && <p className="text-gray-400 text-sm">No usage data.</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
