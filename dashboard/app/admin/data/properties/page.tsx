"use client";
import { useEffect, useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { formatZAR, formatDate } from "@/lib/format";
import { propertyTitle, propertySubtitle } from "@/lib/property-title";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type P = Record<string, any>;

export default function PropertiesPage() {
  const router = useRouter();

  // Add property
  const [input, setInput] = useState("");
  const [addLoading, setAddLoading] = useState(false);

  // Properties table
  const [rows, setRows] = useState<P[]>([]);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [sort, setSortState] = useState("scraped_desc");

  // Load saved sort on mount
  useEffect(() => {
    const saved = localStorage.getItem("surepath_sort");
    if (saved) setSortState(saved);
  }, []);

  // Persist sort changes
  function setSort(val: string) {
    setSortState(val);
    localStorage.setItem("surepath_sort", val);
  }
  const [loading, setLoading] = useState(true);

  function loadProperties() {
    const p = new URLSearchParams();
    if (search) p.set("q", search);
    if (filter === "has_report") p.set("has_report", "true");
    if (filter === "no_report") p.set("has_report", "false");
    setLoading(true);
    fetch(`/api/properties?${p}`).then(r => r.json()).then((data) => {
      let filtered = data;
      if (filter === "no_photos") filtered = data.filter((r: P) => parseInt(r.photo_count) === 0);
      if (filter === "has_photos") filtered = data.filter((r: P) => parseInt(r.photo_count) > 0);
      setRows(filtered);
    }).finally(() => setLoading(false));
  }

  useEffect(() => { loadProperties(); }, [search, filter]);

  // Data depth: count how many data points we have per property
  function dataDepth(r: P): number {
    let d = 0;
    if (r.lat) d++;                              // geocoded
    if (parseInt(r.photo_count) > 0) d++;        // has photos
    if (parseInt(r.analysed_count) > 0) d++;      // vision done
    if (r.report_id) d++;                         // has report
    if (parseInt(r.has_deeds) > 0) d++;           // has deeds
    if (r.asking_price) d++;                      // has price
    if (r.description) d++;                       // has description
    if (r.agent_name) d++;                        // has agent
    if (r.levies || r.rates_and_taxes) d++;       // has costs
    if (r.street_address) d++;                    // has street address
    return d;
  }

  // Sort — useMemo to ensure React re-derives when sort or rows change
  const sortedRows = useMemo(() => {
    const sorted = [...rows];
    sorted.sort((a, b) => {
      switch (sort) {
        case "scraped_desc": return new Date(b.last_scraped_at || b.created_at).getTime() - new Date(a.last_scraped_at || a.created_at).getTime();
        case "scraped_asc": return new Date(a.last_scraped_at || a.created_at).getTime() - new Date(b.last_scraped_at || b.created_at).getTime();
        case "listed_desc": return (b.listing_date ? new Date(b.listing_date).getTime() : 0) - (a.listing_date ? new Date(a.listing_date).getTime() : 0);
        case "listed_asc": return (a.listing_date ? new Date(a.listing_date).getTime() : Infinity) - (b.listing_date ? new Date(b.listing_date).getTime() : Infinity);
        case "data_desc": return dataDepth(b) - dataDepth(a);
        case "data_asc": return dataDepth(a) - dataDepth(b);
        case "price_desc": return (b.asking_price || 0) - (a.asking_price || 0);
        case "price_asc": return (a.asking_price || Infinity) - (b.asking_price || Infinity);
        default: return 0;
      }
    });
    return sorted;
  }, [rows, sort]);

  // Add property with log
  const [addLog, setAddLog] = useState<string[]>([]);

  async function addProperty() {
    if (!input) return;
    setAddLoading(true);
    setAddLog(["Submitting..."]);
    try {
      const res = await fetch("/api/lookup", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: input }),
      });
      const json = await res.json();
      if (json.log) setAddLog(json.log);
      if (json.id) {
        setAddLog(prev => [...prev, json.created ? (json.scraped ? "Property created and scraped" : "Property created") : "Found existing property"]);
        setTimeout(() => {
          setInput("");
          setAddLoading(false);
          setAddLog([]);
          router.push(`/admin/data/inspect/${json.id}`);
        }, json.log?.length > 2 ? 2000 : 500);
      } else {
        setAddLog(prev => [...prev, json.error || "Failed to add property"]);
        setAddLoading(false);
      }
    } catch (err) {
      setAddLog(prev => [...prev, `Error: ${err instanceof Error ? err.message : String(err)}`]);
      setAddLoading(false);
    }
  }

  // Data status indicators
  const dot = (ok: boolean, label: string) => (
    <span title={label} className={`inline-block w-2 h-2 rounded-full ${ok ? "bg-green-500" : "bg-gray-300"}`} />
  );

  // Summary stats
  const total = rows.length;
  const withCoords = rows.filter(r => r.lat).length;
  const withPhotos = rows.filter(r => parseInt(r.photo_count) > 0).length;
  const withAnalysis = rows.filter(r => parseInt(r.analysed_count) > 0).length;
  const withReports = rows.filter(r => r.report_id).length;
  const withDeeds = rows.filter(r => parseInt(r.has_deeds) > 0).length;

  return (
    <div>
      {/* Add Property */}
      <div className="bg-white border rounded-lg p-4 mb-6">
        <div className="flex gap-3 items-end">
          <div className="flex-1">
            <label className="text-xs text-gray-500 block mb-1">Add a property — paste a Property24 URL, PrivateProperty URL, or type a street address</label>
            <input className="w-full border-2 border-[#0D1B2A] rounded px-3 py-2 text-sm focus:border-[#E63946] focus:outline-none" value={input} onChange={e => setInput(e.target.value)} placeholder="" />
          </div>
          <button onClick={addProperty} disabled={addLoading || !input}
            className="bg-[#0D1B2A] text-white px-5 py-2 rounded font-semibold hover:bg-gray-800 disabled:opacity-50 h-[38px] shrink-0">
            {addLoading ? "Working..." : "Add Property"}
          </button>
        </div>
        {addLog.length > 0 && (
          <div className="mt-3 bg-gray-50 border rounded p-3 text-xs font-mono space-y-0.5 max-h-48 overflow-y-auto">
            {addLog.map((line, i) => (
              <div key={i} className={`${line.startsWith("Error") || line.includes("failed") || line.includes("Failed") ? "text-red-600" : line.includes("Found") || line.includes("Scraped") || line.includes("Saved") || line.includes("Geocoded") || line.includes("created") ? "text-green-700" : "text-gray-600"}`}>
                {line.startsWith("Error") || line.includes("failed") ? "✗ " : line.includes("Found") || line.includes("Scraped") || line.includes("Saved") || line.includes("Geocoded") || line.includes("created") ? "✓ " : "→ "}{line}
              </div>
            ))}
            {addLoading && <div className="text-gray-400 animate-pulse">Working...</div>}
          </div>
        )}
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-6 gap-3 mb-4">
        {[
          { label: "Properties", val: total, color: "text-[#0D1B2A]" },
          { label: "Geocoded", val: `${withCoords}/${total}`, color: withCoords === total ? "text-green-600" : "text-yellow-600" },
          { label: "With Photos", val: `${withPhotos}/${total}`, color: withPhotos > 0 ? "text-green-600" : "text-red-500" },
          { label: "Vision Done", val: `${withAnalysis}/${total}`, color: withAnalysis > 0 ? "text-green-600" : "text-gray-400" },
          { label: "Reports", val: `${withReports}/${total}`, color: withReports > 0 ? "text-green-600" : "text-gray-400" },
          { label: "Deeds Data", val: `${withDeeds}/${total}`, color: withDeeds > 0 ? "text-green-600" : "text-gray-400" },
        ].map(c => (
          <div key={c.label} className="bg-white border rounded p-3 text-center">
            <div className={`text-xl font-bold ${c.color}`}>{String(c.val)}</div>
            <div className="text-[10px] text-gray-500 uppercase tracking-wide">{c.label}</div>
          </div>
        ))}
      </div>

      {/* Filters + Sort */}
      <div className="flex gap-3 mb-4 items-center flex-wrap">
        <input className="border rounded px-3 py-1.5 text-sm w-72" placeholder="Search address, ERF, suburb, city..." value={search} onChange={e => setSearch(e.target.value)} />
        <select className="border rounded px-3 py-1.5 text-sm" value={filter} onChange={e => setFilter(e.target.value)}>
          <option value="all">All properties</option>
          <option value="has_report">Has report</option>
          <option value="no_report">No report</option>
          <option value="has_photos">Has photos</option>
          <option value="no_photos">No photos</option>
        </select>
        <select className="border rounded px-3 py-1.5 text-sm" value={sort} onChange={e => setSort(e.target.value)}>
          <option value="scraped_desc">Scraped: newest first</option>
          <option value="scraped_asc">Scraped: oldest first</option>
          <option value="listed_desc">Listed: newest first</option>
          <option value="listed_asc">Listed: oldest first</option>
          <option value="data_desc">Most data first</option>
          <option value="data_asc">Least data first</option>
          <option value="price_desc">Price: high to low</option>
          <option value="price_asc">Price: low to high</option>
        </select>
        <span className="text-xs text-gray-400">{sortedRows.length} shown</span>
      </div>

      {/* Table */}
      {loading ? <p className="text-gray-500">Loading...</p> : (
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-[#0D1B2A] text-white text-left">
              <th className="px-3 py-2 w-8">#</th>
              <th className="px-3 py-2">Property</th>
              <th className="px-3 py-2">Price</th>
              <th className="px-3 py-2 text-center">Data</th>
              <th className="px-3 py-2">Listed</th>
              <th className="px-3 py-2">Scraped</th>
              <th className="px-3 py-2">Decision</th>
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((r, idx) => (
              <tr key={r.id} className="border-b hover:bg-gray-50 cursor-pointer" onClick={() => router.push(`/admin/data/inspect/${r.id}`)}>
                <td className="px-3 py-2 text-xs text-gray-400 font-mono">{idx + 1}</td>
                <td className="px-3 py-2">
                  <div className="max-w-xs truncate font-medium">{propertyTitle(r)}</div>
                  <div className="text-[10px] text-gray-400">{propertySubtitle(r)}</div>
                  {r.agency_name && <div className="text-[10px] text-gray-400">{r.agency_name}{r.agent_name ? ` — ${r.agent_name}` : ""}</div>}
                </td>
                <td className="px-3 py-2 text-xs font-medium">{r.asking_price ? formatZAR(r.asking_price) : "—"}</td>
                <td className="px-3 py-2">
                  <div className="flex gap-1.5 justify-center" title="Geo | Photos | Vision | Report | Deeds">
                    {dot(!!r.lat, "Geocoded")}
                    {dot(parseInt(r.photo_count) > 0, `${r.photo_count} photos`)}
                    {dot(parseInt(r.analysed_count) > 0, `${r.analysed_count} analysed`)}
                    {dot(!!r.report_id, "Report")}
                    {dot(parseInt(r.has_deeds) > 0, "Deeds")}
                  </div>
                  <div className="text-[9px] text-gray-400 text-center mt-0.5">{dataDepth(r)}/10</div>
                </td>
                <td className="px-3 py-2 text-[10px] text-gray-400">
                  {r.listing_date ? formatDate(r.listing_date) : "—"}
                </td>
                <td className="px-3 py-2 text-[10px] text-gray-400">
                  {r.last_scraped_at ? formatDate(r.last_scraped_at) : formatDate(r.created_at)}
                </td>
                <td className="px-3 py-2">
                  {r.decision ? (
                    <span className={`font-bold text-xs ${r.decision === "BUY" ? "text-green-600" : r.decision === "NEGOTIATE" ? "text-yellow-600" : r.decision === "WALK_AWAY" ? "text-red-600" : "text-orange-500"}`}>
                      {r.decision}
                    </span>
                  ) : <span className="text-gray-300 text-xs">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!loading && sortedRows.length === 0 && <p className="text-gray-400 mt-4">No properties found.</p>}
    </div>
  );
}
