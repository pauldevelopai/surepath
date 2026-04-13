"use client";
import { useEffect, useState, useRef, useCallback } from "react";

/* eslint-disable @typescript-eslint/no-explicit-any */

const SCRAPERS = [
  { id: "pp", label: "PrivateProperty", desc: "Listings, photos, pricing — the raw property data that starts every report", color: "bg-blue-600", hover: "hover:bg-blue-700" },
  { id: "crime", label: "Crime Data", desc: "CrimeHub / SAPS — suburb crime stats for risk scoring", color: "bg-red-700", hover: "hover:bg-red-800" },
  { id: "solar", label: "Solar Data", desc: "PVGIS — satellite-measured irradiance for solar scoring", color: "bg-yellow-600", hover: "hover:bg-yellow-700" },
  { id: "water", label: "Water Quality", desc: "DWS Blue/Green Drop — municipal water & sewerage scores", color: "bg-sky-700", hover: "hover:bg-sky-800" },
  { id: "gvr", label: "Municipal GVR", desc: "Valuation rolls — stand size, zoning, municipal values (6 metros)", color: "bg-emerald-700", hover: "hover:bg-emerald-800" },
  { id: "saps", label: "SAPS Stations", desc: "Police precincts + CPF contacts — enables crime suburb mapping", color: "bg-slate-700", hover: "hover:bg-slate-800" },
  { id: "assist247", label: "Assist247", desc: "Security companies mapped to suburbs — armed response coverage", color: "bg-teal-700", hover: "hover:bg-teal-800" },
  { id: "procompare", label: "Procompare", desc: "Security company ratings — supplements Assist247 coverage data", color: "bg-cyan-700", hover: "hover:bg-cyan-800" },
  { id: "schools", label: "Schools", desc: "Google Places — school proximity and ratings within 3km", color: "bg-purple-700", hover: "hover:bg-purple-800" },
  { id: "climate", label: "Climate", desc: "Open-Meteo — 5yr rainfall, humidity, wind, frost, damp risk", color: "bg-orange-700", hover: "hover:bg-orange-800" },
  { id: "loadshedding", label: "Load Shedding", desc: "EskomSePush — schedules and stage by area", color: "bg-gray-700", hover: "hover:bg-gray-800" },
  { id: "soldprices", label: "Sold Prices", desc: "Property24 — recent suburb sale prices for AVM", color: "bg-green-700", hover: "hover:bg-green-800" },
  { id: "pricetrends", label: "Price Trends", desc: "Suburb price history, YoY growth, market indicators, price per sqm", color: "bg-lime-700", hover: "hover:bg-lime-800" },
  { id: "propertycosts", label: "Property Costs", desc: "Transfer duty, bond costs, attorney fees, agent commission — the REAL price", color: "bg-rose-700", hover: "hover:bg-rose-800" },
  { id: "fibre", label: "Fibre Coverage", desc: "ISP coverage check — Openserve, Vumatel, Frogfoot", color: "bg-indigo-700", hover: "hover:bg-indigo-800" },
  { id: "electricity", label: "Electricity", desc: "Eskom/municipal tariffs + load shedding status — monthly cost estimates", color: "bg-amber-700", hover: "hover:bg-amber-800" },
  { id: "articles", label: "Articles", desc: "SA construction, renovation, defect articles — web sources to Knowledge Base", color: "bg-[#E63946]", hover: "hover:bg-red-700" },
  { id: "pexels", label: "Pexels Stock Footage", desc: "Vertical stock videos for social content — kitchens, defects, signing, emotion (API)", color: "bg-pink-600", hover: "hover:bg-pink-700" },
  { id: "mixkit", label: "Mixkit Free Videos", desc: "Free stock videos scraped and trimmed to 2s — stored in our S3 so we own them", color: "bg-fuchsia-600", hover: "hover:bg-fuchsia-700" },
  { id: "unsplash", label: "Unsplash Free Photos", desc: "Free stock photos for beats where stills work better than video", color: "bg-violet-600", hover: "hover:bg-violet-700" },
  { id: "trending", label: "Trending Hashtags", desc: "Refresh SA property trending hashtags from TikTok Creative Center + curated list for captions", color: "bg-purple-700", hover: "hover:bg-purple-800" },
];

function formatDuration(startStr: string): string {
  const ms = Date.now() - new Date(startStr).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export default function ScraperPage() {
  const [data, setData] = useState<any>(null);
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [masterStatus, setMasterStatus] = useState<any>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [expandedLogs, setExpandedLogs] = useState<Record<string, boolean>>({});
  const [now, setNow] = useState(Date.now());
  const [today, setToday] = useState<any>(null);
  const [todayLoading, setTodayLoading] = useState(true);
  const [aiLoading, setAiLoading] = useState(false);
  const pollRef = useRef<NodeJS.Timeout | null>(null);

  const load = useCallback(() => {
    fetch("/api/scraper").then(r => r.json()).then(setData).finally(() => setLoading(false));
    fetch("/api/scraper/collect-stats").then(r => r.json()).then(setStats).catch(() => {});
    fetch("/api/scraper", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "scraper_status" }) })
      .then(r => r.json()).then(setMasterStatus).catch(() => {});
  }, []);

  const loadToday = useCallback((withSuggestions: boolean) => {
    if (withSuggestions) setAiLoading(true);
    fetch(`/api/scraper/today${withSuggestions ? "?suggestions=1" : ""}`)
      .then(r => r.json())
      .then(setToday)
      .catch(() => {})
      .finally(() => { setTodayLoading(false); setAiLoading(false); });
  }, []);

  useEffect(() => { loadToday(false); }, [loadToday]);

  useEffect(() => { load(); }, [load]);

  const anyRunning = data?.scraper_running;
  useEffect(() => {
    pollRef.current = setInterval(() => { load(); setNow(Date.now()); }, anyRunning ? 2000 : 15000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [anyRunning, load]);

  // Suppress unused var warning — now is used to trigger re-renders for duration display
  void now;

  async function post(body: any) {
    await fetch("/api/scraper", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    load();
  }

  function getProcessInfo(id: string) {
    const procs = data?.scraper_processes || [];
    const proc = procs.find((p: any) => p.name === id);
    if (!proc) return { running: false, orphaned: false, pid: 0, started: "" };
    return {
      running: proc.running,
      orphaned: (proc.log?.[0] || "").includes("orphaned"),
      pid: proc.pid || 0,
      started: proc.started || "",
    };
  }

  function getLog(id: string): string[] {
    return (data?.scraper_processes || []).find((p: any) => p.name === id)?.log || [];
  }

  function getAllErrors(): string[] {
    const errors: string[] = [];
    for (const p of (data?.scraper_processes || [])) {
      for (const line of (p.log || [])) {
        if (line.includes("ERROR") || line.includes("FAIL") || line.includes("FATAL") || line.includes("KILLED")) {
          errors.push(line);
        }
      }
    }
    for (const line of (data?.scraper_log || [])) {
      if ((line.includes("ERROR") || line.includes("FAIL") || line.includes("FATAL") || line.includes("KILLED")) && !errors.includes(line)) {
        errors.push(line);
      }
    }
    return errors.slice(-50);
  }

  if (loading || !data) return <p className="text-gray-500 p-8">Loading...</p>;

  const totals = data.totals || {};
  const s = stats || {};
  const errors = getAllErrors();

  const counts: Record<string, { pending: number; done: number; total: number; unit: string }> = {
    pp:           { pending: (s.pp_universe || 0) - (s.pp_total || totals.pp_properties || 0), done: s.pp_total || totals.pp_properties || 0, total: s.pp_universe || 208500, unit: "listings" },
    crime:        { pending: s.crime_pending || 0, done: s.crime_total || 0, total: (s.crime_pending || 0) + (s.crime_total || 0), unit: "suburbs" },
    solar:        { pending: s.solar_pending || 0, done: s.solar_total || 0, total: (s.solar_pending || 0) + (s.solar_total || 0), unit: "properties" },
    water:        { pending: s.water_pending || 0, done: s.water_total || 0, total: (s.water_pending || 0) + (s.water_total || 0), unit: "cities" },
    gvr:          { pending: 0, done: s.gvr_total || 0, total: s.gvr_total || 0, unit: "properties" },
    saps:         { pending: Math.max(0, 1154 - (s.saps_total || 0)), done: s.saps_total || 0, total: 1154, unit: "stations" },
    assist247:    { pending: 0, done: s.assist247_suburbs || 0, total: s.assist247_suburbs || 0, unit: "suburbs" },
    procompare:   { pending: 0, done: s.procompare_companies || 0, total: s.procompare_companies || 0, unit: "companies" },
    schools:      { pending: s.schools_pending || 0, done: s.schools_total || 0, total: (s.schools_pending || 0) + (s.schools_total || 0), unit: "suburbs" },
    climate:      { pending: s.climate_pending || 0, done: s.climate_total || 0, total: (s.climate_pending || 0) + (s.climate_total || 0), unit: "suburbs" },
    loadshedding: { pending: 0, done: s.loadshedding_total || 0, total: s.loadshedding_total || 0, unit: "areas" },
    soldprices:    { pending: 0, done: s.soldprices_total || 0, total: s.soldprices_total || 0, unit: "suburbs" },
    pricetrends:   { pending: s.pricetrends_pending || 0, done: s.pricetrends_total || 0, total: (s.pricetrends_pending || 0) + (s.pricetrends_total || 0), unit: "suburbs" },
    propertycosts: { pending: s.propertycosts_pending || 0, done: s.propertycosts_total || 0, total: (s.propertycosts_pending || 0) + (s.propertycosts_total || 0), unit: "properties" },
    fibre:         { pending: 0, done: s.fibre_total || 0, total: s.fibre_total || 0, unit: "areas" },
    electricity:   { pending: 0, done: s.electricity_total || 0, total: s.electricity_total || 0, unit: "areas" },
    articles:      { pending: 0, done: s.kb_total || 0, total: s.kb_total || 0, unit: "entries" },
    pexels:        { pending: 0, done: s.pexels_total || 0, total: s.pexels_total || 0, unit: "videos" },
    mixkit:        { pending: 0, done: s.mixkit_total || 0, total: s.mixkit_total || 0, unit: "videos" },
    unsplash:      { pending: 0, done: s.unsplash_total || 0, total: s.unsplash_total || 0, unit: "photos" },
    trending:      { pending: 0, done: s.trending_total || 0, total: s.trending_total || 0, unit: "tags" },
  };

  const ragLayers: Record<string, number> = s.rag_chunks_by_layer || {};
  const ragTotal: number = s.rag_total_chunks || 0;
  const ragLastSeeded: string | null = s.rag_last_seeded || null;
  const ragPending: Record<string, { pending: number; layer: string }> = s.rag_pending_by_source || {};
  const totalRagPending = Object.values(ragPending).reduce((sum, v) => sum + (v.pending || 0), 0);

  const ragReseedRunning = getProcessInfo("rag-reseed").running;

  const layerColors: Record<string, string> = {
    knowledge: "bg-amber-600", evidence: "bg-red-600", vision: "bg-purple-600",
    live: "bg-sky-600", crime: "bg-red-800", security: "bg-teal-600",
    report: "bg-green-600", feedback: "bg-orange-600", property: "bg-blue-600",
    security_company: "bg-cyan-700",
  };

  const t = today || {};
  const tTotals = t.totals || { runs: 0, collected: 0, errors: 0, failed_scrapers: 0, empty_scrapers: 0 };
  const tLastNight: any[] = t.last_night || [];
  const tGaps: string[] = t.gaps || [];
  const tUnder: any[] = t.underperformers || [];
  const tBacklog: any[] = t.backlog || [];

  return (
    <div>
      {/* ─── Today review ─── */}
      <div className="mb-4 bg-gradient-to-br from-[#0D1B2A] to-[#1a2a3f] rounded-lg p-4 border border-gray-700">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-lg font-bold text-white">☀️ Today — Morning Review</h2>
            <p className="text-[11px] text-gray-400">Last 24 hours of scraper activity</p>
          </div>
          <button
            onClick={() => loadToday(true)}
            disabled={aiLoading}
            className="px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold rounded disabled:opacity-50"
          >
            {aiLoading ? "Analyzing…" : t.suggestions ? "Refresh AI Brief" : "Generate AI Brief"}
          </button>
        </div>

        {todayLoading ? (
          <p className="text-gray-500 text-sm">Loading…</p>
        ) : (
          <>
            {/* Top-line tiles */}
            <div className="grid grid-cols-5 gap-2 mb-3">
              <div className="bg-black/30 rounded p-2"><div className="text-[10px] text-gray-500 uppercase">Runs</div><div className="text-xl font-bold text-white">{tTotals.runs}</div></div>
              <div className="bg-black/30 rounded p-2"><div className="text-[10px] text-gray-500 uppercase">Collected</div><div className="text-xl font-bold text-green-400">{tTotals.collected.toLocaleString()}</div></div>
              <div className="bg-black/30 rounded p-2"><div className="text-[10px] text-gray-500 uppercase">Errors</div><div className={"text-xl font-bold " + (tTotals.errors > 0 ? "text-red-400" : "text-gray-500")}>{tTotals.errors}</div></div>
              <div className="bg-black/30 rounded p-2"><div className="text-[10px] text-gray-500 uppercase">Failed</div><div className={"text-xl font-bold " + (tTotals.failed_scrapers > 0 ? "text-red-400" : "text-gray-500")}>{tTotals.failed_scrapers}</div></div>
              <div className="bg-black/30 rounded p-2"><div className="text-[10px] text-gray-500 uppercase">Empty</div><div className={"text-xl font-bold " + (tTotals.empty_scrapers > 0 ? "text-amber-400" : "text-gray-500")}>{tTotals.empty_scrapers}</div></div>
            </div>

            {tLastNight.length === 0 && (
              <p className="text-amber-400 text-sm bg-amber-950/30 border border-amber-900/40 rounded p-2 mb-3">
                No scraper runs recorded in the last 24 hours. Either nothing was scheduled or the run tracker is not yet wired into your cron.
              </p>
            )}

            {/* Per-scraper last night */}
            {tLastNight.length > 0 && (
              <div className="mb-3">
                <div className="text-xs font-semibold text-gray-300 mb-1">Last night per scraper</div>
                <div className="bg-black/40 rounded overflow-hidden">
                  <table className="w-full text-xs">
                    <thead className="bg-black/40 text-gray-400">
                      <tr>
                        <th className="text-left px-2 py-1">Scraper</th>
                        <th className="text-right px-2 py-1">Collected</th>
                        <th className="text-right px-2 py-1">Errors</th>
                        <th className="text-right px-2 py-1">Duration</th>
                        <th className="text-left px-2 py-1">Status</th>
                        <th className="text-left px-2 py-1">Last error</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tLastNight.map((row: any) => (
                        <tr key={row.scraper} className="border-t border-gray-800">
                          <td className="px-2 py-1 text-white font-mono">{row.scraper}</td>
                          <td className="px-2 py-1 text-right text-green-300">{row.collected}</td>
                          <td className={"px-2 py-1 text-right " + (row.errors > 0 ? "text-red-400" : "text-gray-600")}>{row.errors}</td>
                          <td className="px-2 py-1 text-right text-gray-400">{row.duration_seconds}s</td>
                          <td className="px-2 py-1">
                            <span className={"px-1.5 py-0.5 rounded text-[10px] " +
                              (row.status === "success" ? "bg-green-900/60 text-green-300" :
                               row.status === "failed" || row.status === "timeout" ? "bg-red-900/60 text-red-300" :
                               row.status === "empty" ? "bg-gray-800 text-gray-400" :
                               "bg-amber-900/60 text-amber-300")}>{row.status}</span>
                          </td>
                          <td className="px-2 py-1 text-red-400 truncate max-w-md" title={row.last_error || ""}>{row.last_error || ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Gaps + underperformers + backlog */}
            <div className="grid grid-cols-3 gap-3 mb-3">
              <div className="bg-black/30 rounded p-2">
                <div className="text-xs font-semibold text-gray-300 mb-1">Scheduled but didn&apos;t run</div>
                {tGaps.length === 0 ? <div className="text-[11px] text-gray-500">None — all scheduled scrapers ran ✓</div> :
                  <div className="flex flex-wrap gap-1">{tGaps.map((g) => <span key={g} className="px-1.5 py-0.5 bg-amber-900/60 text-amber-300 text-[10px] rounded font-mono">{g}</span>)}</div>}
              </div>
              <div className="bg-black/30 rounded p-2">
                <div className="text-xs font-semibold text-gray-300 mb-1">7-day underperformers</div>
                {tUnder.length === 0 ? <div className="text-[11px] text-gray-500">None ✓</div> :
                  <ul className="text-[11px] space-y-0.5">{tUnder.slice(0, 5).map((u: any) => <li key={u.scraper} className="text-red-300"><span className="font-mono">{u.scraper}</span> — {u.fail_rate}% fail, {u.collected} collected over {u.runs} runs</li>)}</ul>}
              </div>
              <div className="bg-black/30 rounded p-2">
                <div className="text-xs font-semibold text-gray-300 mb-1">Coverage backlog</div>
                {tBacklog.length === 0 ? <div className="text-[11px] text-gray-500">—</div> :
                  <ul className="text-[11px] space-y-0.5">{tBacklog.map((b: any) => <li key={b.type} className="text-gray-300"><span className="font-mono">{b.type}</span>: <span className="text-amber-300">{Number(b.pending).toLocaleString()}</span> pending</li>)}</ul>}
              </div>
            </div>

            {/* AI brief */}
            {t.suggestions && (
              <div className="bg-amber-950/30 border border-amber-900/40 rounded p-3">
                <div className="text-xs font-bold text-amber-300 mb-2">🤖 AI Morning Brief</div>
                <div className="text-[12px] text-amber-100 whitespace-pre-wrap leading-relaxed">{t.suggestions}</div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Master scraper status banner */}
      {masterStatus?.running && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-4">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-3">
              <span className="w-3 h-3 rounded-full bg-green-500 animate-pulse" />
              <div>
                <span className="font-bold text-sm text-green-800">Scraping Everything</span>
                <span className="text-xs text-green-600 ml-2">
                  Pass {masterStatus.pass} — {masterStatus.current_scraper || "starting"}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <span className="text-xs text-green-700 font-mono">{masterStatus.total_collected} collected</span>
              {masterStatus.started_at && (
                <span className="text-xs text-green-700 font-mono font-bold">
                  {formatDuration(masterStatus.started_at)}
                </span>
              )}
              <span className="text-[9px] text-green-500">
                Started {masterStatus.started_at ? new Date(masterStatus.started_at).toLocaleTimeString() : "?"}
              </span>
              <button onClick={() => post({ action: "stop_all_scraping" })} className="px-4 py-1.5 bg-red-600 text-white rounded text-sm font-semibold hover:bg-red-700">
                Stop
              </button>
            </div>
          </div>
          {masterStatus.scrapers && Object.keys(masterStatus.scrapers).length > 0 && (
            <div className="grid grid-cols-5 gap-2 mt-3">
              {Object.entries(masterStatus.scrapers).map(([name, sc]: [string, any]) => (
                <div key={name} className={`text-[10px] px-2 py-1 rounded ${sc.done ? "bg-green-200 text-green-800" : masterStatus.current_scraper?.toLowerCase().includes(name) ? "bg-green-300 text-green-900 font-bold" : "bg-green-100 text-green-700"}`}>
                  <div className="flex justify-between">
                    <span>{name}</span>
                    <span>{sc.total_processed}{sc.done ? " done" : ""}</span>
                  </div>
                  {sc.total_errors > 0 && <span className="text-red-600"> ({sc.total_errors} err)</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold">Scrapers</h1>
          <p className="text-sm text-gray-500">
            {totals.properties} properties — {totals.pp_properties || 0} PP, {totals.p24_properties || 0} P24 — {totals.images} images
          </p>
        </div>
        <div className="flex gap-2">
          {!masterStatus?.running ? (
            <button onClick={() => post({ action: "scrape_all" })} className="bg-[#E63946] text-white px-5 py-2 rounded font-semibold text-sm hover:bg-red-700">
              Scrape Everything
            </button>
          ) : (
            <button onClick={() => post({ action: "stop_all_scraping" })} className="bg-red-600 text-white px-5 py-2 rounded font-semibold text-sm hover:bg-red-700">
              Stop Scraping
            </button>
          )}
          {anyRunning && (
            <button onClick={() => post({ action: "stop" })} className="bg-red-600 text-white px-5 py-2 rounded font-semibold text-sm hover:bg-red-700">
              Stop All
            </button>
          )}
          <button
            onClick={() => { if (confirm("Force kill ALL scraper processes? This sends SIGKILL.")) { post({ action: "kill_all_scrapers" }).then(() => post({ action: "stop_all_scraping" })); } }}
            className="bg-gray-800 text-white px-4 py-2 rounded font-semibold text-sm hover:bg-black"
            title="Force kill all scraper processes (SIGKILL)"
          >
            Force Kill
          </button>
        </div>
      </div>

      {/* Error log panel */}
      {errors.length > 0 && (
        <div className="mb-4">
          <button
            onClick={() => setShowErrors(!showErrors)}
            className="flex items-center gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800 hover:bg-red-100 w-full text-left"
          >
            <span className="w-2 h-2 rounded-full bg-red-500" />
            <span className="font-semibold">{errors.length} error{errors.length !== 1 ? "s" : ""}</span>
            <span className="text-red-500 text-xs ml-1">click to {showErrors ? "hide" : "show"}</span>
          </button>
          {showErrors && (
            <div className="mt-1 bg-[#1a0a0a] rounded-b-lg px-4 py-3 font-mono text-[11px] max-h-64 overflow-y-auto border border-red-900/30">
              {errors.map((line, i) => (
                <div key={i} className="text-red-400">{line}</div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* RAG summary link */}
      <div className="mb-4 bg-[#0D1B2A] rounded-lg p-3 border border-gray-800 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-sm font-bold text-gray-200">RAG Seeding</span>
          <span className="text-xs text-gray-500 font-mono">{ragTotal.toLocaleString()} chunks</span>
          {totalRagPending > 0 && <span className="text-xs text-amber-400 font-mono">{totalRagPending.toLocaleString()} pending</span>}
          {ragLastSeeded && <span className="text-[10px] text-gray-600">seeded {new Date(ragLastSeeded).toLocaleString()}</span>}
        </div>
        <a href="/admin/data/knowledge-base" className="px-3 py-1 bg-amber-600 text-white rounded text-xs font-semibold hover:bg-amber-700">Manage</a>
      </div>

      {/* Running process status bar */}
      {(data.scraper_processes || []).length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {(data.scraper_processes || []).map((p: any) => {
            const isOrphaned = (p.log?.[0] || "").includes("orphaned");
            return (
              <div key={p.name} className={"flex items-center gap-2 px-3 py-1.5 rounded text-xs font-mono " + (isOrphaned ? "bg-yellow-50 border border-yellow-300 text-yellow-800" : "bg-green-50 border border-green-200 text-green-800")}>
                <span className={"w-2 h-2 rounded-full animate-pulse " + (isOrphaned ? "bg-yellow-500" : "bg-green-500")} />
                <span className="font-semibold">{p.name}</span>
                <span className="text-gray-500">PID {p.pid}</span>
                {isOrphaned && <span className="text-yellow-600 text-[9px]">(orphaned)</span>}
                {p.started && <span className="text-gray-600 font-bold">{formatDuration(p.started)}</span>}
              </div>
            );
          })}
        </div>
      )}

      {/* Scraper cards */}
      <div className="flex flex-col gap-3">
        {SCRAPERS.map(sc => {
          const proc = getProcessInfo(sc.id);
          const log = getLog(sc.id);
          const ct = counts[sc.id] || { pending: 0, done: 0, total: 0, unit: "" };
          const pct = ct.total > 0 ? Math.round((ct.done / ct.total) * 100) : 0;
          const hasErrors = log.some(l => l.includes("ERROR") || l.includes("FAIL"));
          const logExpanded = expandedLogs[sc.id] || false;

          return (
            <div key={sc.id} className="rounded-lg overflow-hidden border">
              <div className={"flex items-center justify-between px-4 py-2.5 text-white " + sc.color}>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-sm">{sc.label}</span>
                    {proc.running && !proc.orphaned && <span className="w-2 h-2 rounded-full bg-white animate-pulse" />}
                    {proc.orphaned && (
                      <span className="px-1.5 py-0.5 bg-yellow-400 text-yellow-900 text-[9px] rounded font-bold">ORPHANED</span>
                    )}
                    {proc.running && proc.pid > 0 && (
                      <span className="text-[9px] opacity-60 font-mono">PID {proc.pid}</span>
                    )}
                    {proc.running && proc.started && (
                      <span className="text-[10px] opacity-80 font-mono font-bold">{formatDuration(proc.started)}</span>
                    )}
                    {hasErrors && !proc.running && (
                      <span className="px-1.5 py-0.5 bg-red-500/40 text-white text-[9px] rounded">ERRORS</span>
                    )}
                  </div>
                  <div className="text-[10px] opacity-60 truncate">{sc.desc}</div>
                </div>

                {/* Progress bar + counts */}
                <div className="flex items-center gap-3 mx-3">
                  {ct.total > 0 && (
                    <div className="w-32">
                      <div className="flex justify-between text-[9px] opacity-70 mb-0.5">
                        <span>{ct.done.toLocaleString()} {ct.unit}</span>
                        <span>{pct}%</span>
                      </div>
                      <div className="h-1.5 bg-white/20 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-white/70 rounded-full transition-all duration-500"
                          style={{ width: `${Math.max(pct, 1)}%` }}
                        />
                      </div>
                      {ct.pending > 0 && (
                        <div className="text-[9px] opacity-50 mt-0.5">{ct.pending.toLocaleString()} pending</div>
                      )}
                    </div>
                  )}
                </div>

                {/* Start/Stop + log toggle */}
                <div className="flex items-center gap-1.5">
                  {log.length > 0 && (
                    <button
                      onClick={() => setExpandedLogs(prev => ({ ...prev, [sc.id]: !prev[sc.id] }))}
                      className="bg-white/10 hover:bg-white/20 text-white px-2 py-1.5 rounded text-[10px]"
                    >
                      {logExpanded ? "Hide" : "Log"} ({log.length})
                    </button>
                  )}
                  {proc.running ? (
                    <button onClick={() => post({ action: "stop", name: sc.id })} className="bg-white/20 hover:bg-white/30 text-white px-3 py-1.5 rounded text-sm font-medium">
                      Stop
                    </button>
                  ) : (
                    <button onClick={() => post({ action: "start", source: sc.id })} className={"bg-white/20 text-white px-3 py-1.5 rounded text-sm font-medium " + sc.hover}>
                      Start
                    </button>
                  )}
                </div>
              </div>

              {/* Log output */}
              {(logExpanded || proc.running) && log.length > 0 && (
                <div className="bg-[#0D1B2A] px-4 py-3 font-mono text-[11px] max-h-48 overflow-y-auto">
                  {log.slice(-40).map((line: string, i: number) => (
                    <div key={i} className={
                      line.includes("ERROR") || line.includes("FAIL") || line.includes("FATAL") ? "text-red-400" :
                      line.includes("NEW") ? "text-green-300 font-bold" :
                      line.includes("OK") || line.includes("success") ? "text-green-300" :
                      line.includes("SKIP") || line.includes("skipped") ? "text-gray-600" :
                      line.includes("===") || line.includes("complete") || line.includes("Complete") ? "text-green-400 font-bold" :
                      line.includes("KILLED") || line.includes("timeout") ? "text-yellow-400" :
                      "text-gray-400"
                    }>{line}</div>
                  ))}
                  {proc.running && <div className="text-gray-500 animate-pulse mt-1">Running...</div>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
