"use client";
import { useEffect, useState, useRef, useCallback } from "react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type A = Record<string, any>;

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
  { id: "fibre", label: "Fibre Coverage", desc: "ISP coverage check — Openserve, Vumatel, Frogfoot", color: "bg-indigo-700", hover: "hover:bg-indigo-800" },
  { id: "electricity", label: "Electricity", desc: "Eskom/municipal tariffs + load shedding status — monthly cost estimates", color: "bg-amber-700", hover: "hover:bg-amber-800" },
  { id: "articles", label: "Articles", desc: "SA construction, renovation, defect articles — web sources → Knowledge Base", color: "bg-[#E63946]", hover: "hover:bg-red-700" },
];

export default function ScraperPage() {
  const [data, setData] = useState<A | null>(null);
  const [stats, setStats] = useState<A | null>(null);
  const [loading, setLoading] = useState(true);
  const [masterStatus, setMasterStatus] = useState<A | null>(null);
  const pollRef = useRef<NodeJS.Timeout | null>(null);

  const load = useCallback(() => {
    fetch("/api/scraper").then(r => r.json()).then(setData).finally(() => setLoading(false));
    fetch("/api/scraper/collect-stats").then(r => r.json()).then(setStats).catch(() => {});
    fetch("/api/scraper", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "scraper_status" }) })
      .then(r => r.json()).then(setMasterStatus).catch(() => {});
  }, []);

  useEffect(() => { load(); }, [load]);

  const anyRunning = data?.scraper_running;
  useEffect(() => {
    pollRef.current = setInterval(load, anyRunning ? 2000 : 15000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [anyRunning, load]);

  async function startScraper(id: string) {
    await fetch("/api/scraper", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "start", source: id }),
    });
    load();
  }

  async function stopScraper(name: string) {
    await fetch("/api/scraper", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "stop", name }),
    });
    load();
  }

  async function stopAll() {
    await fetch("/api/scraper", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "stop" }),
    });
    load();
  }

  async function runAll() {
    await fetch("/api/scraper", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "scrape_all" }),
    });
    load();
  }

  async function stopMaster() {
    await fetch("/api/scraper", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "stop_all_scraping" }),
    });
    load();
  }

  async function forceKillAll() {
    if (!confirm("Force kill ALL scraper processes? This sends SIGKILL.")) return;
    await fetch("/api/scraper", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "kill_all_scrapers" }),
    });
    // Also stop master
    await fetch("/api/scraper", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "stop_all_scraping" }),
    });
    load();
  }


  function isRunning(id: string) {
    return (data?.scraper_processes || []).some((p: A) => p.name === id && p.running);
  }
  function getLog(id: string): string[] {
    return (data?.scraper_processes || []).find((p: A) => p.name === id)?.log || [];
  }

  if (loading || !data) return <p className="text-gray-500 p-8">Loading...</p>;

  const { totals } = data;
  const s = stats || {};

  // Pending and done counts per scraper
  const counts: Record<string, { pending: number; done: number; unit: string }> = {
    pp:         { pending: (s.pp_universe || 0) - (s.pp_total || totals.pp_properties || 0), done: s.pp_total || totals.pp_properties || 0, unit: "listings" },
    crime:      { pending: s.crime_pending || 0,   done: s.crime_total || 0,                     unit: "suburbs" },
    solar:      { pending: s.solar_pending || 0,   done: s.solar_total || 0,                     unit: "properties" },
    water:      { pending: s.water_pending || 0,   done: s.water_total || 0,                     unit: "cities" },
    gvr:        { pending: 0,                       done: s.gvr_total || 0,                       unit: "properties" },
    saps:       { pending: (1154 - (s.saps_total || 0)), done: s.saps_total || 0,                unit: "stations" },
    assist247:  { pending: 0,                       done: s.assist247_suburbs || 0,               unit: "suburbs" },
    procompare: { pending: 0,                       done: s.procompare_companies || 0,            unit: "companies" },
    schools:    { pending: s.schools_pending || 0, done: s.schools_total || 0,                   unit: "suburbs" },
    climate:    { pending: s.climate_pending || 0, done: s.climate_total || 0,                   unit: "suburbs" },
    loadshedding: { pending: 0,                    done: s.loadshedding_total || 0,              unit: "areas" },
    soldprices: { pending: 0,                      done: s.soldprices_total || 0,                unit: "suburbs" },
    fibre:      { pending: 0,                      done: s.fibre_total || 0,                     unit: "areas" },
    electricity: { pending: 0,                     done: s.electricity_total || 0,                unit: "areas" },
    articles:   { pending: 0,                      done: s.kb_total || 0,                        unit: "entries" },
  };

  return (
    <div>
      {/* ─── Master scraper status banner ─── */}
      {masterStatus?.running && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-4">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-3">
              <span className="w-3 h-3 rounded-full bg-green-500 animate-pulse" />
              <div>
                <span className="font-bold text-sm text-green-800">Scraping Everything</span>
                <span className="text-xs text-green-600 ml-2">Pass {masterStatus.pass} — {masterStatus.current_scraper || 'starting'}</span>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <span className="text-xs text-green-700 font-mono">{masterStatus.total_collected} collected</span>
              <span className="text-[9px] text-green-500">Started {masterStatus.started_at ? new Date(masterStatus.started_at).toLocaleTimeString() : '?'}</span>
              <button onClick={stopMaster} className="px-4 py-1.5 bg-red-600 text-white rounded text-sm font-semibold hover:bg-red-700">Stop</button>
            </div>
          </div>
          {Object.keys(masterStatus.scrapers || {}).length > 0 && (
            <div className="flex flex-wrap gap-3 mt-2">
              {Object.entries(masterStatus.scrapers as Record<string, A>).map(([name, s]) => (
                <span key={name} className={`text-[9px] px-2 py-0.5 rounded ${s.done ? 'bg-green-200 text-green-800' : 'bg-green-100 text-green-700'}`}>
                  {name}: {s.total_processed} {s.done ? '(done)' : ''}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Scrapers</h1>
          <p className="text-sm text-gray-500">
            {totals.properties} properties — {totals.pp_properties || 0} PP, {totals.p24_properties || 0} P24 — {totals.images} images
          </p>
        </div>
        <div className="flex gap-2">
          {!masterStatus?.running ? (
            <button onClick={runAll} className="bg-[#E63946] text-white px-5 py-2 rounded font-semibold text-sm hover:bg-red-700">
              Scrape Everything
            </button>
          ) : (
            <button onClick={stopMaster} className="bg-red-600 text-white px-5 py-2 rounded font-semibold text-sm hover:bg-red-700">
              Stop Scraping
            </button>
          )}
          {anyRunning && (
            <button onClick={stopAll} className="bg-red-600 text-white px-5 py-2 rounded font-semibold text-sm hover:bg-red-700">
              Stop All
            </button>
          )}
          <button onClick={forceKillAll} className="bg-gray-800 text-white px-4 py-2 rounded font-semibold text-sm hover:bg-black" title="Force kill all scraper processes (SIGKILL)">
            Force Kill
          </button>
        </div>
      </div>

      {/* Scraper cards — each with its own log */}
      <div className="flex flex-col gap-4">
        {SCRAPERS.map(sc => {
          const running = isRunning(sc.id);
          const log = getLog(sc.id);
          const ct = counts[sc.id];

          return (
            <div key={sc.id} className="rounded-lg overflow-hidden border">
              {/* Header bar */}
              <div className={`flex items-center justify-between px-5 py-3 text-white ${sc.color}`}>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-bold">{sc.label}</span>
                    {running && <span className="w-2 h-2 rounded-full bg-white animate-pulse" />}
                  </div>
                  <div className="text-[11px] opacity-70">{sc.desc}</div>
                </div>

                {/* Counts */}
                <div className="flex gap-4 mx-4 text-center">
                  {ct.pending > 0 && (
                    <div>
                      <div className="text-lg font-bold">{ct.pending.toLocaleString()}</div>
                      <div className="text-[9px] opacity-60">pending</div>
                    </div>
                  )}
                  <div>
                    <div className="text-lg font-bold">{ct.done.toLocaleString()}</div>
                    <div className="text-[9px] opacity-60">{ct.unit} done</div>
                  </div>
                </div>

                {/* Start/Stop */}
                <div>
                  {running ? (
                    <button onClick={() => stopScraper(sc.id)} className="bg-white/20 hover:bg-white/30 text-white px-4 py-1.5 rounded text-sm font-medium">
                      Stop
                    </button>
                  ) : (
                    <button onClick={() => startScraper(sc.id)} className={`bg-white/20 ${sc.hover} text-white px-4 py-1.5 rounded text-sm font-medium`}>
                      Start
                    </button>
                  )}
                </div>
              </div>

              {/* Log output */}
              {log.length > 0 && (
                <div className="bg-[#0D1B2A] px-4 py-3 font-mono text-[11px] max-h-48 overflow-y-auto">
                  {log.slice(-40).map((line: string, i: number) => (
                    <div key={i} className={
                      line.includes("ERROR") || line.includes("FAIL") ? "text-red-400" :
                      line.includes("NEW") ? "text-green-300 font-bold" :
                      line.includes("OK") || line.includes("success") ? "text-green-300" :
                      line.includes("SKIP") || line.includes("skipped") ? "text-gray-600" :
                      line.includes("===") || line.includes("complete") || line.includes("Complete") ? "text-green-400 font-bold" :
                      "text-gray-400"
                    }>{line}</div>
                  ))}
                  {running && <div className="text-gray-500 animate-pulse mt-1">Running...</div>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
