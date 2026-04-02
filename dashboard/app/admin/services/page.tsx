"use client";
import { useEffect, useState } from "react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type A = Record<string, any>;

export default function ServicesPage() {
  const [data, setData] = useState<A | null>(null);
  const [city, setCity] = useState("");
  const [trade, setTrade] = useState("");
  const [search, setSearch] = useState("");

  function load() {
    const p = new URLSearchParams();
    if (city) p.set("city", city);
    if (trade) p.set("trade", trade);
    if (search) p.set("q", search);
    fetch(`/api/services?${p}`).then(r => r.json()).then(setData);
  }

  useEffect(() => { load(); }, [city, trade, search]);

  if (!data) return <p className="text-gray-500">Loading...</p>;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">Service Providers</h1>
      <p className="text-sm text-gray-500 mb-4">
        {data.providers.length} providers from{" "}
        <a href="https://www.snupit.co.za" target="_blank" rel="noreferrer" className="text-blue-500">Snupit</a> and{" "}
        <a href="https://kandua.com" target="_blank" rel="noreferrer" className="text-blue-500">Kandua</a>
      </p>

      {/* Filters */}
      <div className="flex gap-3 mb-4">
        <select className="border rounded px-3 py-1.5 text-sm" value={city} onChange={e => setCity(e.target.value)}>
          <option value="">All cities</option>
          {data.cities.map((c: string) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select className="border rounded px-3 py-1.5 text-sm" value={trade} onChange={e => setTrade(e.target.value)}>
          <option value="">All trades</option>
          {data.trades.map((t: string) => <option key={t} value={t}>{t}</option>)}
        </select>
        <input className="border rounded px-3 py-1.5 text-sm w-60" placeholder="Search name..." value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      {/* Stats */}
      <div className="flex gap-2 mb-4 flex-wrap">
        {data.stats.map((s: A, i: number) => (
          <div key={i} className="bg-white border rounded px-3 py-1.5 text-xs">
            <span className="font-bold capitalize">{s.trade}</span>
            <span className="text-gray-400 ml-1">{s.city}</span>
            <span className="font-mono ml-2">{s.cnt}</span>
            {s.avg_rating && <span className="text-yellow-600 ml-1">{Number(s.avg_rating).toFixed(1)}/5</span>}
          </div>
        ))}
      </div>

      {/* Table */}
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="bg-[#0D1B2A] text-white text-left">
            <th className="px-3 py-2">Name</th>
            <th className="px-3 py-2">Trade</th>
            <th className="px-3 py-2">City</th>
            <th className="px-3 py-2">Rating</th>
            <th className="px-3 py-2">Reviews</th>
            <th className="px-3 py-2">Source</th>
          </tr>
        </thead>
        <tbody>
          {data.providers.map((p: A) => (
            <tr key={p.id} className="border-b hover:bg-gray-50">
              <td className="px-3 py-2 font-medium">{p.name}</td>
              <td className="px-3 py-2 capitalize">{p.trade}</td>
              <td className="px-3 py-2 text-gray-500">{p.suburb ? `${p.suburb}, ` : ""}{p.city}</td>
              <td className="px-3 py-2">
                {p.rating ? (
                  <span className="text-yellow-600 font-bold">{p.rating}/5</span>
                ) : <span className="text-gray-300">—</span>}
              </td>
              <td className="px-3 py-2 text-gray-500">{p.review_count || "—"}</td>
              <td className="px-3 py-2">
                <a href={p.source_url} target="_blank" rel="noreferrer" className="text-xs text-blue-500 hover:underline">{p.source_name}</a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.providers.length === 0 && <p className="text-gray-400 mt-4">No providers found. Run the collector: <code className="bg-gray-100 px-1 rounded text-xs">node bootstrap/collect-service-providers.js --all</code></p>}
    </div>
  );
}
