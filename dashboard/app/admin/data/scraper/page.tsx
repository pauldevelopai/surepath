"use client";
import { useEffect, useState, useRef, useCallback } from "react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type A = Record<string, any>;

const SCRAPERS = [
  { id: "pp", label: "PrivateProperty", desc: "Newest listings first, all provinces", color: "bg-blue-600", hover: "hover:bg-blue-700" },
  { id: "crime", label: "Crime Data", desc: "CrimeHub / SAPS — all police stations", color: "bg-red-700", hover: "hover:bg-red-800" },
  { id: "solar", label: "Solar Data", desc: "PVGIS — satellite-measured irradiance", color: "bg-yellow-600", hover: "hover:bg-yellow-700" },
  { id: "saps", label: "SAPS Stations", desc: "~1,154 police stations + CPF contacts — saps.gov.za", color: "bg-slate-700", hover: "hover:bg-slate-800" },
  { id: "assist247", label: "Assist247", desc: "Security companies mapped to suburbs — assist247.co.za", color: "bg-teal-700", hover: "hover:bg-teal-800" },
  { id: "procompare", label: "Procompare", desc: "Security companies with ratings — procompare.co.za", color: "bg-cyan-700", hover: "hover:bg-cyan-800" },
];

export default function ScraperPage() {
  const [data, setData] = useState<A | null>(null);
  const [stats, setStats] = useState<A | null>(null);
  const [loading, setLoading] = useState(true);
  const pollRef = useRef<NodeJS.Timeout | null>(null);

  const load = useCallback(() => {
    fetch("/api/scraper").then(r => r.json()).then(setData).finally(() => setLoading(false));
    fetch("/api/scraper/collect-stats").then(r => r.json()).then(setStats).catch(() => {});
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
    for (const s of SCRAPERS) {
      if (!isRunning(s.id)) {
        await fetch("/api/scraper", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "start", source: s.id }),
        });
      }
    }
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
    saps:       { pending: (1154 - (s.saps_total || 0)), done: s.saps_total || 0,                unit: "stations" },
    assist247:  { pending: 0,                       done: s.assist247_suburbs || 0,               unit: "suburbs" },
    procompare: { pending: 0,                       done: s.procompare_companies || 0,            unit: "companies" },
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Scrapers</h1>
          <p className="text-sm text-gray-500">
            {totals.properties} properties — {totals.pp_properties || 0} PP, {totals.p24_properties || 0} P24 — {totals.images} images
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={runAll} disabled={anyRunning} className="bg-[#0D1B2A] text-white px-5 py-2 rounded font-semibold text-sm disabled:opacity-40 hover:bg-[#1a2d42]">
            Run All
          </button>
          {anyRunning && (
            <button onClick={stopAll} className="bg-red-600 text-white px-5 py-2 rounded font-semibold text-sm hover:bg-red-700">
              Stop All
            </button>
          )}
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
