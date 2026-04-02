"use client";
import { useState, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { formatZAR } from "@/lib/format";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type A = Record<string, any>;

export default function SearchPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [query, setQuery] = useState(searchParams.get("q") || "");
  const [results, setResults] = useState<A | null>(null);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);

  function search(q: string) {
    if (q.length < 2) { setResults(null); return; }
    setLoading(true);
    fetch(`/api/search?q=${encodeURIComponent(q)}`)
      .then(r => r.json())
      .then(setResults)
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(query), 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query]);

  const [lookupLoading, setLookupLoading] = useState(false);

  async function lookupAddress() {
    setLookupLoading(true);
    const res = await fetch("/api/lookup", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: query }),
    });
    const json = await res.json();
    setLookupLoading(false);
    if (json.id) router.push(`/admin/data/inspect/${json.id}`);
  }

  const grouped: Record<string, A[]> = {};
  if (results?.results) {
    for (const r of results.results) {
      if (!grouped[r.category]) grouped[r.category] = [];
      grouped[r.category].push(r);
    }
  }

  const categoryIcons: Record<string, string> = {
    Properties: "🏠", Suburbs: "📍", Agents: "👤", Findings: "🔍", "Risk Data": "⚠️",
  };

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-bold mb-4">Search</h1>

      <input
        className="w-full border-2 border-[#0D1B2A] rounded-lg px-4 py-3 text-lg focus:outline-none focus:border-[#E63946]"
        placeholder="Search properties, suburbs, agents, findings, risks..."
        value={query}
        onChange={e => setQuery(e.target.value)}
        autoFocus
      />

      {/* Address lookup — create new property from any address */}
      {query.length >= 5 && results && results.results.length === 0 && !loading && (
        <div className="mt-3 bg-blue-50 border border-blue-200 rounded-lg p-4 flex items-center justify-between">
          <div>
            <div className="font-bold text-sm text-blue-800">Property not in our system</div>
            <div className="text-xs text-blue-600">Create a property profile for &ldquo;{query}&rdquo; and start collecting data</div>
          </div>
          <button onClick={lookupAddress} disabled={lookupLoading}
            className="bg-blue-600 text-white px-4 py-2 rounded text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 shrink-0">
            {lookupLoading ? "Creating..." : "Create Property Profile"}
          </button>
        </div>
      )}

      {/* Also show lookup option even when results exist */}
      {query.length >= 5 && results && results.results.length > 0 && (
        <button onClick={lookupAddress} disabled={lookupLoading}
          className="mt-2 text-xs text-blue-600 hover:underline">
          Not finding what you need? Create a new property profile for &ldquo;{query}&rdquo;
        </button>
      )}

      {loading && <p className="text-gray-400 mt-4 text-sm">Searching...</p>}

      {results && !loading && (
        <div className="mt-2 text-xs text-gray-400">
          {results.results.length} results across {Object.keys(grouped).length} categories
        </div>
      )}

      {results && Object.keys(grouped).length === 0 && !loading && query.length >= 2 && (
        <p className="text-gray-400 mt-6">No results for &ldquo;{query}&rdquo;</p>
      )}

      <div className="mt-4 space-y-6">
        {Object.entries(grouped).map(([category, items]) => (
          <div key={category}>
            <h2 className="text-sm font-bold text-gray-500 mb-2">
              {categoryIcons[category] || ""} {category} ({items.length})
            </h2>
            <div className="space-y-1">
              {items.map((r, i) => (
                <div key={i}
                  className={`bg-white border rounded p-3 text-sm ${r.type === "property" || r.type === "finding" ? "cursor-pointer hover:bg-gray-50" : ""}`}
                  onClick={() => {
                    if (r.type === "property" || r.type === "finding") router.push(`/admin/data/inspect/${r.id}`);
                    if (r.type === "suburb") router.push(`/admin/data/properties?q=${r.suburb}`);
                  }}
                >
                  <div className="flex justify-between items-start">
                    <div>
                      <div className="font-medium">{r.title}</div>
                      {r.subtitle && <div className="text-xs text-gray-500">{r.subtitle}</div>}
                    </div>
                    <div className="text-right shrink-0 ml-4">
                      {r.asking_price ? <span className="font-bold text-sm">{formatZAR(r.asking_price)}</span> : null}
                      {r.count ? <span className="text-xs text-gray-400">{r.count} properties</span> : null}
                      {r.avg_price ? <div className="text-[10px] text-gray-400">avg {formatZAR(Math.round(r.avg_price))}</div> : null}
                      {r.severity ? <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                        r.severity === "CRITICAL" ? "bg-red-600 text-white" :
                        r.severity === "HIGH" ? "bg-orange-500 text-white" :
                        "bg-yellow-400 text-black"
                      }`}>{r.severity}</span> : null}
                      {r.source_name ? <div className="text-[9px] text-blue-500">{r.source_name}</div> : null}
                    </div>
                  </div>
                  {r.bedrooms ? <div className="text-[10px] text-gray-400 mt-0.5">{r.bedrooms}bed/{r.bathrooms}bath &middot; {r.property_type}</div> : null}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
