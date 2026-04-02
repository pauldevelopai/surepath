"use client";
import { useEffect, useState, useRef } from "react";
import { formatDate } from "@/lib/format";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type A = Record<string, any>;

export default function ScraperPage() {
  const [data, setData] = useState<A | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [delay, setDelay] = useState("3");
  const [maxPages, setMaxPages] = useState("100");
  const [selectedSuburb, setSelectedSuburb] = useState("");
  const [cityFilter, setCityFilter] = useState("all");
  const [ppProvince, setPpProvince] = useState("western-cape");
  const [ppStartPage, setPpStartPage] = useState("1");
  const [activeTab, setActiveTab] = useState<"pp" | "p24">("pp");
  const [collectRunning, setCollectRunning] = useState(false);
  const [collectLog, setCollectLog] = useState<string[]>([]);
  const [collectStats, setCollectStats] = useState<A | null>(null);
  const [p24Delay, setP24Delay] = useState("15");
  const [p24MaxPages, setP24MaxPages] = useState("50");
  const pollRef = useRef<NodeJS.Timeout | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  function load() {
    fetch("/api/scraper").then(r => r.json()).then(setData).finally(() => setLoading(false));
    // Load collection stats
    fetch("/api/scraper/collect-stats").then(r => r.json()).then(setCollectStats).catch(() => {});
  }

  useEffect(() => { load(); }, []);

  useEffect(() => {
    const interval = data?.scraper_running ? 3000 : 30000;
    pollRef.current = setInterval(load, interval);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [data?.scraper_running]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [data?.scraper_log?.length]);

  async function action(act: string, extra: A = {}) {
    setActionMsg(null);
    const res = await fetch("/api/scraper", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: act, ...extra }),
    });
    const json = await res.json();
    setActionMsg(json.message);
    load();
  }

  if (loading || !data) return <p className="text-gray-500">Loading...</p>;

  const { jobs, totals, scraper_running, scraper_log } = data;
  const pending = jobs.filter((j: A) => j.status === "pending").length;
  const blocked = jobs.filter((j: A) => j.status === "blocked").length;
  const complete = jobs.filter((j: A) => j.status === "complete").length;
  const cities = [...new Set(jobs.map((j: A) => j.city))] as string[];
  const filteredJobs = cityFilter === "all" ? jobs : jobs.filter((j: A) => j.city === cityFilter);

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">Data Scraper</h1>
      <p className="text-sm text-gray-500 mb-4">
        {totals.properties} properties ({totals.p24_properties || 0} from P24, {totals.pp_properties || 0} from PP) — {totals.images} images — {totals.training} training records
      </p>

      {actionMsg && (
        <div className="mb-4 p-3 rounded text-sm bg-blue-50 text-blue-800 border border-blue-200">{actionMsg}</div>
      )}

      {/* Source toggle */}
      <div className="flex border-b mb-4">
        <button onClick={() => setActiveTab("pp")}
          className={`px-5 py-2 text-sm font-bold border-b-2 ${activeTab === "pp" ? "border-blue-600 text-blue-700" : "border-transparent text-gray-400"}`}>
          PrivateProperty.co.za
          <span className="ml-1 text-[10px] font-normal text-green-600">(recommended)</span>
        </button>
        <button onClick={() => setActiveTab("p24")}
          className={`px-5 py-2 text-sm font-bold border-b-2 ${activeTab === "p24" ? "border-[#0D1B2A] text-[#0D1B2A]" : "border-transparent text-gray-400"}`}>
          Property24
          <span className="ml-1 text-[10px] font-normal text-orange-500">(rate-limited)</span>
        </button>
      </div>

      {/* Running banner */}
      {scraper_running && (
        <div className="bg-green-50 border border-green-300 rounded-lg p-4 mb-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="w-3 h-3 rounded-full bg-green-500 animate-pulse" />
            <div>
              <div className="font-bold text-green-800">Scraper is running</div>
              <div className="text-xs text-green-600">Auto-refreshing every 3 seconds</div>
            </div>
          </div>
          <button onClick={() => action("stop")} className="bg-red-600 text-white px-4 py-2 rounded text-sm font-semibold hover:bg-red-700">
            Stop
          </button>
        </div>
      )}

      {/* ═══ PRIVATEPROPERTY TAB ═══ */}
      {activeTab === "pp" && (
        <div>
          {!scraper_running && (
            <div className="bg-white border rounded-lg p-4 mb-4">
              <div className="flex gap-3 items-end flex-wrap">
                <div>
                  <label className="text-[10px] text-gray-500 block mb-1">Province</label>
                  <select className="border rounded px-3 py-1.5 text-sm w-40" value={ppProvince} onChange={e => setPpProvince(e.target.value)}>
                    <option value="western-cape">Western Cape</option>
                    <option value="gauteng">Gauteng</option>
                    <option value="kwazulu-natal">KwaZulu-Natal</option>
                    <option value="eastern-cape">Eastern Cape</option>
                    <option value="free-state">Free State</option>
                  </select>
                </div>
                <div>
                  <label className="text-[10px] text-gray-500 block mb-1">Start page</label>
                  <input className="border rounded px-3 py-1.5 text-sm w-20" value={ppStartPage} onChange={e => setPpStartPage(e.target.value)} />
                </div>
                <div>
                  <label className="text-[10px] text-gray-500 block mb-1">Max pages</label>
                  <input className="border rounded px-3 py-1.5 text-sm w-20" value={maxPages} onChange={e => setMaxPages(e.target.value)} />
                </div>
                <div>
                  <label className="text-[10px] text-gray-500 block mb-1">Delay (sec)</label>
                  <input className="border rounded px-3 py-1.5 text-sm w-16" value={delay} onChange={e => setDelay(e.target.value)} />
                </div>
                <button onClick={() => action("start", {
                  source: "pp", province: ppProvince,
                  province_code: { "western-cape": "4", "gauteng": "3", "kwazulu-natal": "2", "eastern-cape": "7", "free-state": "6" }[ppProvince],
                  start_page: parseInt(ppStartPage), delay: parseInt(delay), max_pages: parseInt(maxPages),
                })} className="bg-blue-600 text-white px-5 py-1.5 rounded text-sm font-semibold hover:bg-blue-700">
                  Start Scraper
                </button>
              </div>
              <div className="mt-2 text-xs text-gray-400">
                No rate limiting — 10+ photos per listing — scrapes ~20 listings per page
              </div>
            </div>
          )}

          {/* ── Free Data Collection (same page) ── */}
          <div className="bg-white border rounded-lg p-4 mb-4">
            <h3 className="font-bold text-sm mb-1">Free Data Collection — No API Costs</h3>
            <p className="text-[10px] text-gray-500 mb-3">Crime stats, solar data, and new listing discovery. Skips properties that already have data.</p>

            <div className="grid grid-cols-3 gap-3 mb-3">
              {[
                { key: "crime", label: "Crime Data", desc: "CrimeHub / SAPS — 1,190 police stations", pending: collectStats?.crime_pending || 0, total: collectStats?.crime_total || 0, bg: "bg-red-50" },
                { key: "solar", label: "Solar Data", desc: "PVGIS — satellite-measured irradiance", pending: collectStats?.solar_pending || 0, total: collectStats?.solar_total || 0, bg: "bg-yellow-50" },
                { key: "discovery", label: "New Listings", desc: "Discover new PP listings in tracked suburbs", pending: collectStats?.suburbs_tracked || 0, total: collectStats?.listings_discovered || 0, bg: "bg-blue-50" },
              ].map(s => (
                <div key={s.key} className={`border rounded p-3 ${s.bg}`}>
                  <div className="font-bold text-xs">{s.label}</div>
                  <div className="text-[9px] text-gray-500 mb-1">{s.desc}</div>
                  <div className="flex justify-between items-end">
                    <div><span className="text-xl font-bold">{s.pending}</span> <span className="text-[9px] text-gray-400">pending</span></div>
                    <div><span className="text-lg font-bold text-green-600">{s.total}</span> <span className="text-[9px] text-gray-400">done</span></div>
                  </div>
                </div>
              ))}
            </div>

            <div className="flex gap-2 flex-wrap">
              <button onClick={async () => {
                setCollectRunning(true); setCollectLog(["Starting crime data collection..."]);
                const res = await fetch("/api/scraper/collect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "crime", limit: 20 }) });
                const json = await res.json(); setCollectLog(json.log || [json.message || "Done"]); setCollectRunning(false); load();
              }} disabled={collectRunning || scraper_running} className="bg-red-600 text-white px-3 py-1.5 rounded text-xs font-semibold disabled:opacity-50 hover:bg-red-700">
                {collectRunning ? "Running..." : "Collect Crime"}
              </button>
              <button onClick={async () => {
                setCollectRunning(true); setCollectLog(["Starting solar data collection..."]);
                const res = await fetch("/api/scraper/collect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "solar", limit: 20 }) });
                const json = await res.json(); setCollectLog(json.log || [json.message || "Done"]); setCollectRunning(false); load();
              }} disabled={collectRunning || scraper_running} className="bg-yellow-600 text-white px-3 py-1.5 rounded text-xs font-semibold disabled:opacity-50 hover:bg-yellow-700">
                {collectRunning ? "Running..." : "Collect Solar"}
              </button>
              <button onClick={async () => {
                setCollectRunning(true); setCollectLog(["Starting PP listing discovery..."]);
                const res = await fetch("/api/scraper/collect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "discovery", limit: 10 }) });
                const json = await res.json(); setCollectLog(json.log || [json.message || "Done"]); setCollectRunning(false); load();
              }} disabled={collectRunning || scraper_running} className="bg-blue-600 text-white px-3 py-1.5 rounded text-xs font-semibold disabled:opacity-50 hover:bg-blue-700">
                {collectRunning ? "Running..." : "Discover Listings"}
              </button>
              <button onClick={async () => {
                setCollectRunning(true); setCollectLog(["Starting full collection run..."]);
                const res = await fetch("/api/scraper/collect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "all", limit: 20 }) });
                const json = await res.json(); setCollectLog(json.log || [json.message || "Done"]); setCollectRunning(false); load();
              }} disabled={collectRunning || scraper_running} className="bg-green-700 text-white px-3 py-1.5 rounded text-xs font-semibold disabled:opacity-50 hover:bg-green-800">
                {collectRunning ? "Running..." : "Run All"}
              </button>
            </div>
          </div>

          {/* Collection log */}
          {collectLog.length > 0 && (
            <div className="bg-[#0D1B2A] rounded-lg p-3 font-mono text-[11px] max-h-60 overflow-y-auto mb-4">
              {collectLog.map((line, i) => (
                <div key={i} className={
                  line.includes("ERROR") || line.includes("FAIL") ? "text-red-400" :
                  line.includes("OK") || line.includes("success") ? "text-green-300" :
                  line.includes("SKIP") ? "text-gray-600" :
                  line.includes("complete") || line.includes("Complete") ? "text-green-400 font-bold" :
                  line.includes("NEW") ? "text-blue-300 font-bold" :
                  "text-gray-400"
                }>{line}</div>
              ))}
              {collectRunning && <div className="text-gray-500 animate-pulse">Working...</div>}
            </div>
          )}
        </div>
      )}

      {/* ═══ PROPERTY24 TAB ═══ */}
      {activeTab === "p24" && (
        <div>
          {!scraper_running && (
            <div className="bg-white border rounded-lg p-4 mb-4">
              <div className="bg-orange-50 border border-orange-200 rounded p-2 mb-3 text-xs text-orange-700">
                Property24 actively blocks scrapers after ~20 requests. Use PrivateProperty instead for bulk scraping.
                P24 is useful for specific suburbs where PP doesn&apos;t have coverage.
              </div>
              <div className="flex gap-3 items-end flex-wrap">
                <div>
                  <label className="text-[10px] text-gray-500 block mb-1">Suburb</label>
                  <select className="border rounded px-3 py-1.5 text-sm w-44" value={selectedSuburb} onChange={e => setSelectedSuburb(e.target.value)}>
                    <option value="">All pending</option>
                    {jobs.filter((j: A) => j.status !== "complete").map((j: A) => (
                      <option key={j.id} value={j.suburb_name}>{j.suburb_name}, {j.city}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-[10px] text-gray-500 block mb-1">Delay (sec)</label>
                  <input className="border rounded px-3 py-1.5 text-sm w-16" value={p24Delay} onChange={e => setP24Delay(e.target.value)} />
                </div>
                <div>
                  <label className="text-[10px] text-gray-500 block mb-1">Max pages</label>
                  <input className="border rounded px-3 py-1.5 text-sm w-16" value={p24MaxPages} onChange={e => setP24MaxPages(e.target.value)} />
                </div>
                <button onClick={() => action("start", { suburb: selectedSuburb || undefined, delay: parseInt(p24Delay), max_pages: parseInt(p24MaxPages) })}
                  className="bg-[#0D1B2A] text-white px-4 py-1.5 rounded text-sm font-semibold">Start</button>
                <button onClick={() => action("start", { suburb: selectedSuburb || undefined, delay: parseInt(p24Delay), max_pages: parseInt(p24MaxPages), refresh: true })}
                  className="bg-gray-200 text-gray-700 px-4 py-1.5 rounded text-sm" title="Re-scan for new listings">Refresh</button>
              </div>
            </div>
          )}

          {/* P24 jobs table */}
          <div className="flex gap-2 mb-3 items-center">
            <div className="flex gap-1">
              <button onClick={() => setCityFilter("all")} className={`px-2 py-0.5 rounded text-[10px] ${cityFilter === "all" ? "bg-[#0D1B2A] text-white" : "bg-gray-100"}`}>All ({jobs.length})</button>
              {cities.map((c: string) => (
                <button key={c} onClick={() => setCityFilter(c)} className={`px-2 py-0.5 rounded text-[10px] ${cityFilter === c ? "bg-[#0D1B2A] text-white" : "bg-gray-100"}`}>
                  {c} ({jobs.filter((j: A) => j.city === c).length})
                </button>
              ))}
            </div>
            {blocked > 0 && (
              <button onClick={() => action("reset_blocked")} className="text-[10px] text-orange-600 hover:underline ml-2">Reset {blocked} blocked</button>
            )}
          </div>

          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="bg-[#0D1B2A] text-white text-left">
                <th className="px-2 py-1.5">Suburb</th>
                <th className="px-2 py-1.5">Status</th>
                <th className="px-2 py-1.5 text-center">Pages</th>
                <th className="px-2 py-1.5 text-right">Stored</th>
                <th className="px-2 py-1.5 w-12"></th>
              </tr>
            </thead>
            <tbody>
              {filteredJobs.map((j: A) => (
                <tr key={j.id} className="border-b hover:bg-gray-50">
                  <td className="px-2 py-1"><span className="font-medium">{j.suburb_name}</span> <span className="text-gray-400">{j.city}</span></td>
                  <td className="px-2 py-1">
                    <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${
                      j.status === "complete" ? "bg-green-100 text-green-700" :
                      j.status === "blocked" ? "bg-orange-100 text-orange-700" :
                      j.status === "in_progress" ? "bg-blue-100 text-blue-700" :
                      "bg-gray-100 text-gray-500"
                    }`}>{j.status}</span>
                  </td>
                  <td className="px-2 py-1 text-center font-mono text-gray-400">{j.last_page_scraped}</td>
                  <td className="px-2 py-1 text-right font-mono font-bold">{j.total_listings_stored || 0}</td>
                  <td className="px-2 py-1 text-right">
                    {!scraper_running && (
                      <button onClick={() => j.status === "complete" || j.status === "blocked" ? action("reset_job", { suburb: j.suburb_name }) : action("start", { suburb: j.suburb_name, delay: parseInt(p24Delay), max_pages: parseInt(p24MaxPages) })}
                        className="text-[9px] text-blue-600 hover:underline">
                        {j.status === "complete" || j.status === "blocked" ? "Reset" : "Run"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Summary bar */}
      <div className="grid grid-cols-6 gap-2 my-4">
        {[
          { label: "Properties", val: totals.properties, color: "text-[#0D1B2A]" },
          { label: "From PP", val: totals.pp_properties || 0, color: "text-blue-600" },
          { label: "From P24", val: totals.p24_properties || 0 },
          { label: "Images", val: totals.images },
          { label: "Training", val: totals.training, color: "text-purple-600" },
          { label: "P24 Blocked", val: blocked, color: blocked > 0 ? "text-orange-600" : "" },
        ].map(c => (
          <div key={c.label} className="bg-white border rounded p-2 text-center">
            <div className={`text-lg font-bold ${c.color || ""}`}>{String(c.val)}</div>
            <div className="text-[9px] text-gray-400 uppercase">{c.label}</div>
          </div>
        ))}
      </div>

      {/* Build training data */}
      <button onClick={() => action("build_training")} className="bg-purple-50 text-purple-700 px-3 py-1 rounded text-xs border border-purple-200 mb-4">
        Rebuild training data
      </button>

      {/* Live log */}
      {scraper_log?.length > 0 && (
        <div className="bg-[#0D1B2A] rounded-lg p-3 font-mono text-[11px] max-h-60 overflow-y-auto">
          {scraper_log.map((line: string, i: number) => (
            <div key={i} className={
              line.includes("[ERROR]") ? "text-red-400" :
              line.includes("NEW") ? "text-green-300 font-bold" :
              line.includes("BLOCKED") ? "text-orange-400 font-bold" :
              line.includes("COMPLETE") ? "text-green-400 font-bold" :
              line.includes("===") ? "text-white" :
              line.includes("SKIP") ? "text-gray-600" :
              "text-gray-500"
            }>{line}</div>
          ))}
          <div ref={logEndRef} />
        </div>
      )}
    </div>
  );
}
