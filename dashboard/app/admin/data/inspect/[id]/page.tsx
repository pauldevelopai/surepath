"use client";
import { useEffect, useState, useRef, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { formatZAR, formatDate, severityColor, humanize } from "@/lib/format";
import { propertyTitle, propertySubtitle } from "@/lib/property-title";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type A = Record<string, any>;

const STEPS = [
  "Property resolution", "Deeds lookup", "Resale check", "Image collection",
  "Vision — listing photos", "Vision — Street View", "Vision — satellite",
  "AVM + comparables", "Suburb intelligence", "Building age risk",
  "B2B propagation", "PDF rendering", "Complete", "Create order", "Complete",
];

const CONFIDENCE_STYLE: Record<string, string> = {
  verified: "text-green-600",
  scraped: "text-blue-600",
  estimated: "text-orange-500",
  unverified: "text-red-500",
};

// A single data field with provenance
function Datum({ label, value, source }: { label: string; value: string | number | null | undefined; source: A | null }) {
  if (value == null || value === "") return null;

  const collectedDate = source?.date ? new Date(source.date).toLocaleDateString("en-ZA", { year: "numeric", month: "short", day: "numeric" }) : null;

  return (
    <div className="py-1.5 border-b border-gray-100 last:border-0">
      <div className="flex justify-between items-baseline gap-4">
        <div>
          <span className="text-xs text-gray-400">{label}</span>
          <div className="font-medium text-sm">{String(value)}</div>
        </div>
        {source ? (
          <div className="text-right shrink-0">
            {source.url ? (
              <a href={source.url} target="_blank" rel="noreferrer" className={`text-[10px] hover:underline ${CONFIDENCE_STYLE[source.confidence] || "text-gray-400"}`}>
                {source.name || source.source}
              </a>
            ) : (
              <span className={`text-[10px] ${CONFIDENCE_STYLE[source.confidence] || "text-gray-400"}`}>{source.name || source.source}</span>
            )}
            <div className="text-[9px] text-gray-300">{source.confidence}{collectedDate ? ` · ${collectedDate}` : ""}</div>
          </div>
        ) : (
          <span className="text-[10px] text-red-400 shrink-0">NO SOURCE</span>
        )}
      </div>
    </div>
  );
}

function FeedbackBtn({ propertyId, section }: { propertyId: number; section: string }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [sent, setSent] = useState(false);

  async function submit() {
    if (!text.trim()) return;
    await fetch("/api/feedback", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ property_id: propertyId, section, feedback: text }),
    });
    setSent(true);
    setTimeout(() => { setOpen(false); setSent(false); setText(""); }, 2000);
  }

  if (sent) return <span className="text-[10px] text-green-600 print:hidden">Feedback saved</span>;

  return (
    <span className="print:hidden">
      {!open ? (
        <button onClick={() => setOpen(true)} className="text-[10px] text-gray-300 hover:text-red-500" title="Report incorrect data">Flag</button>
      ) : (
        <span className="flex gap-1 items-center">
          <input className="border rounded px-1.5 py-0.5 text-[10px] w-48" placeholder="What's wrong with this data?" value={text} onChange={e => setText(e.target.value)} onKeyDown={e => e.key === "Enter" && submit()} autoFocus />
          <button onClick={submit} className="text-[10px] bg-red-500 text-white px-1.5 py-0.5 rounded">Send</button>
          <button onClick={() => setOpen(false)} className="text-[10px] text-gray-400">x</button>
        </span>
      )}
    </span>
  );
}

export default function PropertyDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const [data, setData] = useState<A | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<A | null>(null);
  const [selectedPhotos, setSelectedPhotos] = useState<number[]>([]);
  const [runAllActive, setRunAllActive] = useState(false);
  const [runAllStep, setRunAllStep] = useState("");
  const [genPrice, setGenPrice] = useState("");
  const [genPhone, setGenPhone] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [genStep, setGenStep] = useState(0);
  const [genStatus, setGenStatus] = useState<string | null>(null);
  const [genResult, setGenResult] = useState<A | null>(null);
  const [genError, setGenError] = useState<string | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const [ratings, setRatings] = useState<Record<string, string>>({});

  function rateItem(section: string, hash: string, rating: string, context?: A) {
    const key = `${section}:${hash}`;
    setRatings(prev => ({ ...prev, [key]: rating }));
    fetch("/api/feedback", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ property_id: id, section, finding_hash: hash, rating, context }),
    }).catch(() => {});
  }

  function RateBtn({ section, hash, context }: { section: string; hash: string; context?: A }) {
    const key = `${section}:${hash}`;
    const current = ratings[key];
    return (
      <span className="inline-flex gap-0.5 ml-1 shrink-0">
        <button onClick={() => rateItem(section, hash, "good", context)} className={`text-[11px] px-1 rounded ${current === "good" ? "bg-green-200 text-green-800" : "text-gray-300 hover:text-green-500"}`} title="Good — accurate/useful">&#x25B2;</button>
        <button onClick={() => rateItem(section, hash, "bad", context)} className={`text-[11px] px-1 rounded ${current === "bad" ? "bg-red-200 text-red-800" : "text-gray-300 hover:text-red-500"}`} title="Bad — inaccurate/irrelevant">&#x25BC;</button>
      </span>
    );
  }

  const load = useCallback(() => { fetch(`/api/inspect/${id}`).then(r => r.json()).then(setData); }, [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!jobId || genStatus !== "running") return;
    intervalRef.current = setInterval(async () => {
      const json = await (await fetch(`/api/pipeline-status?job_id=${jobId}`)).json();
      setGenStep(json.step || 0);
      if (json.status === "complete") { setGenStatus("complete"); setGenResult(json.result); clearInterval(intervalRef.current!); load(); }
      else if (json.status === "failed") { setGenStatus("failed"); setGenError(json.error); clearInterval(intervalRef.current!); }
    }, 3000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [jobId, genStatus, load]);

  if (!data) return <p className="text-gray-500 p-6">Loading...</p>;

  const { property: p, sources, unverified_fields: unverified, report: r, images, deeds: d, crime, pdf_exports: pdfExports, affordability: aff } = data;

  // Helpers
  const src = (field: string) => sources?.[field] || null;
  // Get the most recent update date for a set of fields
  const sectionUpdated = (...fields: string[]) => {
    let latest: string | null = null;
    for (const f of fields) {
      const s = sources?.[f];
      if (s?.date && (!latest || s.date > latest)) latest = s.date;
    }
    return latest ? new Date(latest).toLocaleDateString("en-ZA", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : null;
  };
  const hasCoords = !!p.lat;
  const streetviewImg = images?.find((i: A) => i.source === "streetview");
  const satelliteImg = images?.find((i: A) => i.source === "satellite");
  const listingPhotos = images?.filter((i: A) => i.source !== "streetview" && i.source !== "satellite") || [];
  const analysedCount = images?.filter((i: A) => i.vision_analysis).length || 0;
  const hasReport = !!r;
  const hasDeeds = !!d;
  const hasCrime = crime?.incidents?.length > 0;
  // Use linked findings (with photo URLs) if available, otherwise flatten from report
  const findings: A[] = r?._linked_findings || (() => {
    const rawFindings: A[] = r?.vision_findings || [];
    const flat: A[] = [];
    for (const f of rawFindings) {
      if (f.observation && f.severity) flat.push(f);
      else if (Array.isArray(f.findings)) for (const inner of f.findings) if (inner.observation) flat.push(inner);
    }
    return flat;
  })();
  const severityOrder = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "COSMETIC"];
  const bySeverity: Record<string, A[]> = {};
  for (const f of findings) { const s = f.severity || "LOW"; if (!bySeverity[s]) bySeverity[s] = []; bySeverity[s].push(f); }

  function togglePhoto(imgId: number) {
    setSelectedPhotos(prev => prev.includes(imgId) ? prev.filter(x => x !== imgId) : [...prev, imgId]);
  }

  async function collect(action: string) {
    setActionLoading(action); setActionMsg(null);
    const body: A = { action };
    if (action === "vision" && selectedPhotos.length > 0) body.image_ids = selectedPhotos;
    const res = await fetch(`/api/collect/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    setActionMsg({ action, ...(await res.json()) }); setActionLoading(null); load();
  }
  async function generateReport() {
    setGenError(null); setGenResult(null); setGenStatus("running");
    const askingPrice = genPrice ? parseInt(genPrice.replace(/\D/g, "")) : (data?.property?.asking_price || 0);
    try {
      const res = await fetch("/api/synthesise", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ property_id: id, asking_price: askingPrice }),
      });
      const json = await res.json();
      if (json.ok) {
        setGenStatus("complete");
        setGenResult(json);
      } else {
        setGenStatus("failed");
        setGenError(json.error || "Report generation failed");
      }
    } catch (err) {
      setGenStatus("failed");
      setGenError(err instanceof Error ? err.message : "Unknown error");
    }
    load();
  }
  async function runAll() {
    setRunAllActive(true);
    setActionMsg(null);

    const steps = [
      { action: "geocode", label: "Geocoding" },
      { action: "streetview", label: "Capturing Street View" },
      { action: "satellite", label: "Capturing satellite" },
      { action: "rescrape", label: "Scraping photos" },
      { action: "risk", label: "Collecting risk data" },
      { action: "crime", label: "Getting crime statistics" },
      { action: "extract", label: "Extracting features from description" },
      { action: "vision", label: "Analysing listing photos" },
      { action: "analyse_streetview", label: "Analysing Street View" },
      { action: "analyse_satellite", label: "Analysing satellite" },
      { action: "social", label: "Neighbourhood Pros and Cons" },
      { action: "security", label: "Security & Community" },
      { action: "schools", label: "Schools nearby" },
      { action: "climate", label: "Climate profile" },
      { action: "soldprices", label: "Sold prices" },
      { action: "pricetrends", label: "Market trends" },
      { action: "electricity", label: "Electricity data" },
      { action: "fibre", label: "Fibre coverage" },
      { action: "propertycosts", label: "Property costs" },
    ];

    const results: string[] = [];

    for (const step of steps) {
      setRunAllStep(step.label);
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 300000); // 5 min per step
        const res = await fetch(`/api/collect/${id}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: step.action }),
          signal: controller.signal,
        });
        clearTimeout(timeout);
        const json = await res.json();
        results.push(`${step.label}: ${json.ok ? json.message || "done" : "skipped — " + (json.message || json.error || "unknown")}`);
      } catch (err) {
        results.push(`${step.label}: ${err instanceof Error && err.name === "AbortError" ? "timed out (5 min)" : "error — " + (err instanceof Error ? err.message : "unknown")}`);
      }
    }

    setRunAllStep("Done");
    setActionMsg({ ok: true, message: results.join("\n") });
    setRunAllActive(false);
    load();
  }

  const CollectBtn = ({ action, label, ready }: { action: string; label: string; ready: boolean }) => (
    <button onClick={() => collect(action)} disabled={actionLoading === action}
      className={`px-3 py-1.5 rounded text-xs font-semibold ${ready ? "bg-gray-100 text-gray-500 hover:bg-gray-200" : "bg-[#0D1B2A] text-white hover:bg-gray-800"} disabled:opacity-50`}>
      {actionLoading === action ? "Working..." : ready ? `Re-${label}` : label}
    </button>
  );

  return (
    <div className="max-w-5xl">
      {/* Print styles */}
      <style dangerouslySetInnerHTML={{ __html: `
        @media print {
          .no-print, button, input, select, textarea, [class*="hover:bg"] { display: none !important; }
          /* Hide empty sections and UI prompts in print */
          .print-hide-empty:has(.text-gray-400:only-child) { display: none !important; }
          body { background: white !important; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
          section { break-inside: avoid; }
          img { max-width: 100% !important; }
          .print-header { display: block !important; }
          .print-cover { display: flex !important; }
          .max-w-5xl { max-width: 100% !important; padding: 0 !important; }
          aside { display: none !important; }
          main { padding: 0 !important; }
          .flex.min-h-screen { display: block !important; }
          @page { margin: 12mm; size: A4; }
        }
        .print-header { display: none; }
        .print-cover { display: none; }
      `}} />

      <div className="flex justify-between items-center mb-3 no-print">
        <button onClick={() => router.push("/admin/data/properties")} className="text-sm text-gray-500 hover:text-blue-600">&larr; Properties</button>
        <div className="flex gap-2">
          <button onClick={async () => {
              await fetch("/api/export-count", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ property_id: p.id }) });
              window.print();
              load(); // refresh to update count
            }}
            className="bg-[#0D1B2A] text-white px-4 py-2 rounded font-semibold hover:bg-gray-800 text-sm no-print">
            Export Page as PDF
          </button>
          <button onClick={runAll} disabled={runAllActive || actionLoading !== null}
            className="bg-[#E63946] text-white px-5 py-2 rounded font-semibold hover:bg-red-700 disabled:opacity-50 flex items-center gap-2">
            {runAllActive ? (
              <><span className="w-2 h-2 rounded-full bg-white animate-pulse" />{runAllStep}</>
            ) : "Run All Processes"}
          </button>
        </div>
      </div>

      {/* Export history */}
      <div className="flex justify-between items-start mb-2 no-print">
        <div className="text-[10px] text-gray-400">
          PDF exported {p.pdf_export_count || 0} {(p.pdf_export_count || 0) === 1 ? "time" : "times"}
          {pdfExports?.length > 0 && (
            <span className="ml-2 text-gray-300">
              — last: {formatDate(pdfExports[0].created_at)} via {pdfExports[0].source}{pdfExports[0].phone_number ? ` (${pdfExports[0].phone_number.replace("+27", "0")})` : ""}
            </span>
          )}
        </div>
        {pdfExports?.length > 1 && (
          <details className="text-[10px] text-gray-400">
            <summary className="cursor-pointer hover:text-gray-600">Export history</summary>
            <div className="mt-1 bg-gray-50 rounded p-2 border text-[9px] absolute right-6 z-30 w-72">
              {pdfExports.map((e: A, i: number) => (
                <div key={i} className="flex justify-between py-0.5 border-b border-gray-100 last:border-0">
                  <span>{formatDate(e.created_at)}</span>
                  <span className={e.source === "whatsapp" ? "text-green-600" : "text-blue-600"}>{e.source}{e.phone_number ? ` · ${e.phone_number.replace("+27", "0")}` : ""}</span>
                  {e.file_size_bytes && <span className="text-gray-300">{(e.file_size_bytes / 1024 / 1024).toFixed(1)}MB</span>}
                </div>
              ))}
            </div>
          </details>
        )}
      </div>

      {/* Print-only cover page */}
      <div className="print-cover" style={{ flexDirection: "column", justifyContent: "center", alignItems: "center", minHeight: "90vh", textAlign: "center", pageBreakAfter: "always" }}>
        <h1 style={{ fontSize: 48, letterSpacing: 8, color: "#0D1B2A", marginBottom: 40 }}>SUREPATH</h1>
        <div style={{ width: 80, height: 4, background: "#E63946", margin: "0 auto 30px" }} />
        <div style={{ fontSize: 22, color: "#333", marginBottom: 12 }}>{p.street_address || p.address_normalised || p.address_raw}</div>
        <div style={{ fontSize: 14, color: "#666" }}>{p.suburb || ""}{p.suburb && p.city ? ", " : ""}{p.city || ""}{p.province ? `, ${p.province}` : ""}</div>
        <div style={{ fontSize: 14, color: "#666", marginTop: 6 }}>
          {[p.bedrooms && `${p.bedrooms} bed`, p.bathrooms && `${p.bathrooms} bath`, p.floor_area_sqm && `${p.floor_area_sqm} m²`, p.property_type].filter(Boolean).join(" | ")}
        </div>
        {p.asking_price ? <div style={{ fontSize: 28, fontWeight: "bold", marginTop: 20 }}>{formatZAR(p.asking_price)}</div> : null}
        <div style={{ marginTop: 40, fontSize: 12, color: "#999" }}>Report generated: {new Date().toLocaleDateString("en-ZA", { year: "numeric", month: "long", day: "numeric" })}</div>
        {p.listing_url ? <div style={{ fontSize: 9, color: "#BBB", marginTop: 8, wordBreak: "break-all" as const }}>Source: {p.listing_url}</div> : null}
        <div style={{ marginTop: 50, fontSize: 10, color: "#CCC" }}>Confidential Property Intelligence Report</div>
      </div>

      {/* Print-only header (on subsequent pages) */}
      <div className="print-header" style={{ textAlign: "center", marginBottom: 20 }}>
        <h1 style={{ fontSize: 32, letterSpacing: 6, color: "#0D1B2A" }}>SUREPATH</h1>
        <div style={{ width: 60, height: 3, background: "#E63946", margin: "10px auto" }} />
        <p style={{ fontSize: 10, color: "#888" }}>Property Intelligence Report &middot; surepath.co.za &middot; Confidential</p>
      </div>

      {/* Header */}
      <div className="mb-2">
        <h1 className="text-2xl font-bold">{propertyTitle(p)}</h1>
        <div className="text-sm text-gray-500">{propertySubtitle(p)}
          {p.asking_price ? <span className="ml-3 font-bold">{formatZAR(p.asking_price)}</span> : null}
        </div>
        <div className="flex gap-3 mt-1">
          <Datum label="Title" value={p.address_raw} source={src("address_raw")} />
        </div>
        {(p.listing_url || p.data_sources?.p24_url?.url) && (
          <div className="flex flex-col gap-1 mt-1">
            {p.listing_url && (
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-medium text-gray-400 w-8">{p.listing_url.includes('privateproperty') ? 'PP' : 'P24'}</span>
                <a href={p.listing_url} target="_blank" rel="noreferrer" className="text-xs text-blue-600 hover:underline truncate">{p.listing_url}</a>
              </div>
            )}
            {p.data_sources?.p24_url?.url && p.listing_url !== p.data_sources.p24_url.url && (
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-medium text-orange-400 w-8">P24</span>
                <a href={p.data_sources.p24_url.url} target="_blank" rel="noreferrer" className="text-xs text-orange-600 hover:underline truncate">{p.data_sources.p24_url.url}</a>
                <span className="text-[9px] text-gray-300">cross-referenced {p.data_sources.p24_url.date ? new Date(p.data_sources.p24_url.date).toLocaleDateString() : ''}</span>
              </div>
            )}
          </div>
        )}
        <div className="flex gap-3 mt-2 text-xs flex-wrap">
          {p.listing_status && p.listing_status !== "active" && (
            <div className={`border rounded px-2 py-1 font-bold ${p.listing_status === "sold" ? "bg-red-50 border-red-200 text-red-700" : p.listing_status === "under_offer" ? "bg-orange-50 border-orange-200 text-orange-700" : "bg-blue-50 border-blue-200 text-blue-700"}`}>
              {p.listing_status === "sold" ? "SOLD" : p.listing_status === "under_offer" ? "UNDER OFFER" : p.listing_status === "price_reduced" ? "PRICE REDUCED" : p.listing_status.toUpperCase()}
              {p.status_changed_at && <span className="font-normal ml-1">({formatDate(p.status_changed_at)})</span>}
            </div>
          )}
          {p.listing_date && (
            <div className="bg-blue-50 border border-blue-200 rounded px-2 py-1">
              <span className="text-blue-500">Listed:</span> <span className="font-medium">{formatDate(p.listing_date)}</span>
              {(() => { const days = Math.floor((Date.now() - new Date(p.listing_date).getTime()) / 86400000); return days > 0 ? <span className="text-blue-400 ml-1">({days} days on market)</span> : null; })()}
            </div>
          )}
          <div className="bg-gray-50 border border-gray-200 rounded px-2 py-1">
            <span className="text-gray-500">First scraped:</span> <span className="font-medium">{formatDate(p.first_scraped_at || p.created_at)}</span>
          </div>
          {p.last_checked_at && (
            <div className="bg-gray-50 border border-gray-200 rounded px-2 py-1">
              <span className="text-gray-500">Last checked:</span> <span className="font-medium">{formatDate(p.last_checked_at)}</span>
            </div>
          )}
        </div>

        {/* Key metrics bar */}
        {(p.suburb_crime_score || p.solar_ghi_kwh_year || p.water_quality_score) && (
          <div className="flex gap-3 mt-3">
            {p.suburb_crime_score != null && p.suburb_crime_score > 0 && (
              <div className={`flex items-center gap-2 px-3 py-1.5 rounded text-xs font-medium ${p.suburb_crime_score >= 7 ? 'bg-red-100 text-red-800' : p.suburb_crime_score >= 4 ? 'bg-yellow-100 text-yellow-800' : 'bg-green-100 text-green-800'}`}>
                <span className="text-[10px] text-gray-500">Crime</span>
                <span className="font-bold">{p.suburb_crime_score}/10</span>
                <span className="text-[9px]">(SAPS verified)</span>
              </div>
            )}
            {p.solar_ghi_kwh_year && (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded text-xs font-medium bg-yellow-50 text-yellow-800">
                <span className="text-[10px] text-gray-500">Solar</span>
                <span className="font-bold">{Number(p.solar_ghi_kwh_year).toFixed(0)} kWh/m²/yr</span>
                <span className="text-[9px]">(PVGIS verified)</span>
              </div>
            )}
            {p.water_quality_score != null && (
              <div className={`flex items-center gap-2 px-3 py-1.5 rounded text-xs font-medium ${p.water_quality_score >= 7 ? 'bg-green-100 text-green-800' : p.water_quality_score >= 4 ? 'bg-yellow-100 text-yellow-800' : 'bg-red-100 text-red-800'}`}>
                <span className="text-[10px] text-gray-500">Water</span>
                <span className="font-bold">{p.water_quality_score}/10</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Nico's Quick Take */}
      {data.nico_tease && (
        <div className="bg-slate-50 border-l-4 border-slate-800 rounded-r-lg p-4 mt-4">
          <div className="text-[10px] text-gray-400 font-bold mb-1">Nico&apos;s Quick Take</div>
          <div className="text-sm text-gray-700 italic leading-relaxed">&ldquo;{data.nico_tease}&rdquo;</div>
        </div>
      )}

      {/* Status panel — unverified fields + action messages (hidden in print, shown in left sidebar) */}
      {(unverified?.length > 0 || actionMsg) && (
        <div className="no-print fixed left-0 bottom-12 w-56 z-40 space-y-2 p-3" style={{ background: "#0D1B2A" }}>
          {actionMsg && (
            <div className={`p-2 rounded text-[10px] ${actionMsg.ok ? "bg-green-900/50 text-green-300 border border-green-700" : "bg-red-900/50 text-red-300 border border-red-700"}`}>
              {actionMsg.message}
            </div>
          )}
          {unverified?.length > 0 && (
            <div className="bg-white/5 rounded p-2 text-[10px] text-gray-400">
              <div className="text-orange-400 font-bold mb-0.5">Unverified ({unverified.length})</div>
              {unverified.join(", ")}
            </div>
          )}
        </div>
      )}

      <div className="space-y-4">

        {/* ── GEOCODING ── */}
        <section className="bg-white border rounded-lg p-4">
          <div className="flex justify-between items-start mb-2">
            <div>
              <h2 className="font-bold text-sm">Geocoding</h2>
              <div className="text-[10px] text-gray-400"><a href="https://developers.google.com/maps/documentation/geocoding" target="_blank" rel="noreferrer" className="text-blue-500 hover:underline">Google Maps Geocoding API</a>{sectionUpdated("lat", "lng", "address_normalised") && <span className="ml-2 text-gray-300">Updated: {sectionUpdated("lat", "lng", "address_normalised")}</span>}</div>
            </div>
            <CollectBtn action="geocode" label="Geocode" ready={hasCoords} />
          </div>
          {hasCoords ? (
            <div className="grid grid-cols-2 gap-x-6">
              <Datum label="Latitude" value={Number(p.lat).toFixed(6)} source={src("lat")} />
              <Datum label="Longitude" value={Number(p.lng).toFixed(6)} source={src("lng")} />
              <Datum label="Normalised Address" value={p.address_normalised} source={src("address_normalised")} />
              <Datum label="Suburb" value={p.suburb} source={src("suburb")} />
              <Datum label="City" value={p.city} source={src("city")} />
              <Datum label="Province" value={p.province} source={src("province")} />
            </div>
          ) : <p className="text-sm text-gray-400">Not geocoded.</p>}
        </section>

        {/* ── LISTING PHOTOS ── */}
        <section className="bg-white border rounded-lg p-4">
          <div className="flex justify-between items-start mb-2">
            <div>
              <h2 className="font-bold text-sm">Listing Photos ({listingPhotos.length})</h2>
              <div className="text-[10px] text-gray-400">
                Sources: {listingPhotos.length > 0 ? [...new Set(listingPhotos.map((i: A) => i.source))].join(", ") : "none"}
                {p.listing_url ? <> &middot; <a href={p.listing_url} target="_blank" rel="noreferrer" className="text-blue-500 hover:underline">view listing</a></> : null}
              </div>
            </div>
            {p.listing_url && <CollectBtn action="rescrape" label="Re-scrape Photos" ready={listingPhotos.length > 0} />}
          </div>
          {listingPhotos.length > 0 ? (
            <div className="grid grid-cols-4 gap-2">
              {listingPhotos.map((img: A, i: number) => (
                <div key={i} className="relative group">
                  <input type="checkbox" checked={selectedPhotos.includes(img.id)} onChange={() => togglePhoto(img.id)}
                    className="absolute top-1 left-1 z-10" />
                  <a href={img.image_url} target="_blank" rel="noreferrer">
                    <img src={img.image_url} alt={`Photo ${i + 1}`} className="w-full h-24 object-cover rounded border hover:opacity-80 transition" />
                  </a>
                  <div className={`absolute bottom-0 right-0 px-1 text-[9px] rounded-tl ${img.vision_analysis ? "bg-green-500 text-white" : "bg-gray-400 text-white"}`}>
                    {img.vision_analysis ? "analysed" : `#${i + 1}`}
                  </div>
                </div>
              ))}
            </div>
          ) : <p className="text-sm text-gray-400">None. {p.listing_url ? "Click Re-scrape Photos." : ""}</p>}
        </section>

        {/* ── VISION ANALYSIS ── */}
        <section className="bg-white border rounded-lg p-4">
          <div className="flex justify-between items-start mb-2">
            <div>
              <h2 className="font-bold text-sm">What is wrong with this property? ({findings.length} findings)</h2>
              {sectionUpdated("roof_material", "security_visible") && <span className="text-[9px] text-gray-300 ml-2">Updated: {sectionUpdated("roof_material", "security_visible")}</span>}
              <div className="text-[10px] text-gray-400"><a href="https://console.anthropic.com" target="_blank" rel="noreferrer" className="text-blue-500 hover:underline">Anthropic Claude</a> &middot; estimated</div>
            </div>
            <button onClick={() => collect("vision")} disabled={actionLoading === "vision"}
              className="px-3 py-1.5 rounded text-xs font-semibold bg-[#0D1B2A] text-white hover:bg-gray-800 disabled:opacity-50">
              {actionLoading === "vision" ? "Analysing..." : selectedPhotos.length > 0 ? `Analyse ${selectedPhotos.length} selected` : "Analyse all"}
            </button>
          </div>
          {findings.length > 0 ? (
            <>
              <div className="flex gap-1 mb-2">{severityOrder.map(sev => { const c = (bySeverity[sev] || []).length; return c > 0 ? <span key={sev} className={`px-2 py-0.5 rounded text-xs font-bold ${severityColor[sev]}`}>{c} {sev}</span> : null; })}</div>
              <div className="space-y-1">
                {severityOrder.flatMap(sev => (bySeverity[sev] || []).map((f, i) => (
                  <div key={`${sev}-${i}`} className="flex gap-2 items-start text-xs bg-gray-50 p-2 rounded">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold shrink-0 ${severityColor[f.severity] || "bg-gray-200"}`}>{f.severity}</span>
                    <div className="flex-1">
                      <span>{humanize(f.what_it_means || f.output_language || f.observation || f.finding || "")}</span>
                      {f.estimated_repair_cost_zar && <span className="text-gray-400 ml-1">({formatZAR(f.estimated_repair_cost_zar.min)}–{formatZAR(f.estimated_repair_cost_zar.max)})</span>}
                      {f.source_photo && <a href={f.source_photo} target="_blank" rel="noreferrer" className="text-blue-500 hover:underline ml-2">[photo]</a>}
                    </div>
                    <RateBtn section="vision" hash={`${sev}-${i}-${(f.observation||'').slice(0,30)}`} context={{ observation: f.observation, severity: f.severity, category: f.category }} />
                    <span className="text-[9px] text-orange-500 shrink-0">estimated</span>
                  </div>
                )))}
              </div>
            </>
          ) : <p className="text-sm text-gray-400">{(images?.length || 0) > 0 ? "Select photos above then click Analyse." : "No photos to analyse."}</p>}
        </section>

        {/* ── STREET VIEW ── */}
        <section className="bg-white border rounded-lg p-4">
          <div className="flex justify-between items-start mb-2">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="font-bold text-sm">Street View</h2>
                <FeedbackBtn propertyId={p.id} section="streetview" />
              </div>
              <div className="text-[10px] text-gray-400"><a href="https://developers.google.com/maps/documentation/streetview" target="_blank" rel="noreferrer" className="text-blue-500 hover:underline">Google Street View Static API</a></div>
            </div>
            <div className="flex gap-1">
              <CollectBtn action="streetview" label="Capture" ready={!!streetviewImg} />
              {streetviewImg && <CollectBtn action="analyse_streetview" label="Analyse" ready={!!streetviewImg?.vision_analysis} />}
            </div>
          </div>
          {streetviewImg ? (
            <div>
              <a href={streetviewImg.image_url} target="_blank" rel="noreferrer">
                <img src={streetviewImg.image_url} alt="Street View" className="w-48 h-32 rounded object-cover cursor-pointer hover:opacity-80 transition border" />
              </a>
              <div className="text-[9px] text-gray-400 mt-1">Click image to view full size</div>
              {streetviewImg.vision_analysis?.findings?.map((f: A, i: number) => (
                <div key={i} className="flex gap-1 items-start text-xs mt-1">
                  <span className={`px-1 py-0.5 rounded text-[9px] font-bold ${severityColor[f.severity] || "bg-gray-200"}`}>{f.severity}</span>
                  <span className="flex-1">{humanize(f.what_it_means || f.observation)}</span>
                  <RateBtn section="streetview" hash={`sv-${i}`} context={{ observation: f.observation, severity: f.severity }} />
                </div>
              ))}
              {streetviewImg.vision_analysis?.security_observations?.length > 0 && (
                <div className="mt-2 flex gap-1 flex-wrap">
                  {streetviewImg.vision_analysis.security_observations.map((s: string, i: number) => (
                    <span key={i} className="text-[10px] bg-blue-50 text-blue-700 px-2 py-0.5 rounded">{s}</span>
                  ))}
                </div>
              )}
            </div>
          ) : <p className="text-sm text-gray-400">{hasCoords ? "Not captured." : "Geocode first."}</p>}
        </section>

        {/* ── SATELLITE ── */}
        <section className="bg-white border rounded-lg p-4">
          <div className="flex justify-between items-start mb-2">
            <div>
              <h2 className="font-bold text-sm">Satellite / Aerial</h2>
              <div className="text-[10px] text-gray-400"><a href="https://developers.google.com/maps/documentation/maps-static" target="_blank" rel="noreferrer" className="text-blue-500 hover:underline">Google Maps Static API</a></div>
            </div>
            <div className="flex gap-1">
              <CollectBtn action="satellite" label="Capture" ready={!!satelliteImg} />
              {satelliteImg && <CollectBtn action="analyse_satellite" label="Analyse" ready={!!satelliteImg?.vision_analysis} />}
            </div>
          </div>
          {satelliteImg ? (
            <div>
              <a href={satelliteImg.image_url} target="_blank" rel="noreferrer">
                <img src={satelliteImg.image_url} alt="Satellite View" className="w-48 h-32 rounded object-cover cursor-pointer hover:opacity-80 transition border" />
              </a>
              <div className="text-[9px] text-gray-400 mt-1">Click image to view full size</div>
              {satelliteImg.vision_analysis && (() => {
                const satVA = satelliteImg.vision_analysis;
                const satFindings = satVA.findings || [];
                return (
                <div className="mt-2 space-y-2">
                  <div className="flex gap-3 flex-wrap">
                    <div className="bg-gray-50 rounded px-3 py-1.5 text-xs"><span className="text-gray-500">Roof: </span><span className="font-bold capitalize">{satVA.roof_material?.replace(/_/g, ' ') || 'unknown'}</span></div>
                    <div className="bg-gray-50 rounded px-3 py-1.5 text-xs"><span className="text-gray-500">Orientation: </span><span className="font-bold capitalize">{satVA.roof_orientation_estimate || 'unclear'}</span></div>
                    <div className="bg-gray-50 rounded px-3 py-1.5 text-xs"><span className="text-gray-500">Solar: </span><span className={`font-bold ${satVA.solar_installed ? 'text-green-600' : 'text-gray-500'}`}>{satVA.solar_installed ? 'Visible' : 'None'}</span></div>
                    {satVA.asbestos_indicators && <div className="bg-red-50 rounded px-3 py-1.5 text-xs"><span className="text-red-700 font-bold">Asbestos indicators</span></div>}
                  </div>
                  {satFindings.length > 0 && (
                    <div>
                      <div className="text-[10px] text-gray-400 font-bold mb-1">Aerial Analysis ({satFindings.length} findings)</div>
                      {satFindings.map((f: A, i: number) => (
                        <div key={i} className="flex gap-1 items-start text-xs mt-1">
                          <span className={`px-1 py-0.5 rounded text-[9px] font-bold ${severityColor[f.severity] || "bg-gray-200"}`}>{f.severity}</span>
                          <span className="flex-1">{humanize(f.what_it_means || f.observation)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                );
              })()}
            </div>
          ) : <p className="text-sm text-gray-400">{hasCoords ? "Not captured." : "Geocode first."}</p>}
        </section>

        {/* ── DEEDS & OWNERSHIP ── */}
        <section className="bg-white border rounded-lg p-4">
          <div className="flex justify-between items-start mb-2">
            <div>
              <h2 className="font-bold text-sm">Deeds &amp; Ownership</h2>
              <div className="text-[10px] text-gray-400">
                {d?.source === "deedsweb" ? "DeedsWeb (Chief Registrar)" : "Windeed"}{d?.fetched_at ? ` · fetched ${formatDate(d.fetched_at)}` : ""}
                {p.gvr_source ? ` · GVR: ${p.gvr_source}` : ""}
              </div>
            </div>
            <FeedbackBtn propertyId={p.id} section="deeds" />
          </div>

          {hasDeeds || p.owner_name_gvr || p.bond_holder ? (
            <div className="space-y-3">
              {/* Current ownership */}
              <div className="bg-gray-50 rounded p-3 space-y-1">
                {d?.registered_owner && <Datum label="Registered Owner" value={d.registered_owner} source={{ name: d.source || "Windeed", url: "https://www.windeed.co.za", confidence: "verified" }} />}
                {!d?.registered_owner && p.owner_name_gvr && <Datum label="Owner (GVR)" value={p.owner_name_gvr} source={{ name: `GVR ${p.gvr_source || ""}`, confidence: "verified" }} />}
                {d?.title_deed_ref && <Datum label="Title Deed" value={d.title_deed_ref} source={{ name: d.source || "Windeed", confidence: "verified" }} />}
                {d?.lpi_code && <Datum label="LPI Code" value={d.lpi_code} source={{ name: "Deeds Office", confidence: "verified" }} />}
                {d?.deeds_office && <Datum label="Deeds Office" value={d.deeds_office} source={{ name: "DeedsWeb", confidence: "verified" }} />}
              </div>

              {/* Valuation & zoning */}
              {(d?.municipal_value || p.municipal_valuation || p.zoning) && (
                <div className="bg-gray-50 rounded p-3 space-y-1">
                  {(d?.municipal_value || p.municipal_valuation) && (
                    <>
                      <Datum label="Municipal Valuation" value={formatZAR(d?.municipal_value || p.municipal_valuation)} source={{ name: d?.source || "GVR", confidence: "verified" }} />
                      {p.asking_price && (d?.municipal_value || p.municipal_valuation) && (() => {
                        const mv = d?.municipal_value || p.municipal_valuation;
                        const diff = Math.round(((p.asking_price / mv) - 1) * 100);
                        return <p className="text-xs text-gray-500 ml-4">{
                          diff > 30 ? `Asking price is ${diff}% above municipal valuation — significant premium, use as negotiation leverage.`
                          : diff > 0 ? `Asking price is ${diff}% above municipal valuation — slight premium, fairly normal.`
                          : diff < -10 ? `Asking price is ${Math.abs(diff)}% below municipal valuation — potential bargain.`
                          : `Asking price aligns with municipal valuation.`
                        }</p>;
                      })()}
                    </>
                  )}
                  {p.zoning && <Datum label="Zoning" value={p.zoning} source={{ name: `GVR ${p.gvr_source || ""}`, confidence: "verified" }} />}
                  {p.property_category && <Datum label="Property Category" value={p.property_category} source={{ name: `GVR ${p.gvr_source || ""}`, confidence: "verified" }} />}
                  {p.stand_size_sqm && <Datum label="Stand Size" value={`${Number(p.stand_size_sqm).toLocaleString()} m²`} source={{ name: p.gvr_source ? `GVR ${p.gvr_source}` : "listing", confidence: p.gvr_source ? "verified" : "estimated" }} />}
                </div>
              )}

              {/* Bond information */}
              {(p.bond_holder || p.bond_amount) && (
                <div className="bg-blue-50 rounded p-3 space-y-1">
                  <div className="text-[10px] text-blue-600 font-bold uppercase mb-1">Current Bond</div>
                  {p.bond_holder && <Datum label="Bond Holder" value={p.bond_holder} source={{ name: "DeedsWeb", confidence: "verified" }} />}
                  {p.bond_amount && <Datum label="Bond Amount" value={formatZAR(p.bond_amount)} source={{ name: "DeedsWeb", confidence: "verified" }} />}
                  {p.bond_amount && p.asking_price && (
                    <p className="text-xs text-blue-600 ml-4">
                      {p.bond_amount > p.asking_price
                        ? `Bond exceeds asking price by ${formatZAR(p.bond_amount - p.asking_price)} — seller may be under financial pressure. Strong negotiation position.`
                        : `Bond is ${Math.round((p.bond_amount / p.asking_price) * 100)}% of asking price. Equity: ~${formatZAR(p.asking_price - p.bond_amount)}.`
                      }
                    </p>
                  )}
                </div>
              )}

              {/* Transfer history */}
              {d?.transfer_history && Array.isArray(d.transfer_history) && d.transfer_history.length > 0 && (
                <div>
                  <div className="text-[10px] text-gray-500 font-bold uppercase mb-1">Transfer History</div>
                  <div className="space-y-1">
                    {d.transfer_history.map((t: A, ti: number) => {
                      const prevPrice = d.transfer_history[ti + 1]?.price;
                      const appreciation = prevPrice && t.price ? Math.round(((t.price / prevPrice) - 1) * 100) : null;
                      return (
                        <div key={ti} className="bg-gray-50 rounded p-2 text-xs flex items-center gap-3">
                          <div className="shrink-0 text-gray-400 font-mono w-24">{t.date || t.registration_date || "Unknown"}</div>
                          <div className="flex-1">
                            {t.buyer && <span className="font-medium">{t.buyer}</span>}
                            {t.seller && <span className="text-gray-400"> from {t.seller}</span>}
                          </div>
                          <div className="shrink-0 font-bold">{t.price ? formatZAR(t.price) : "—"}</div>
                          {appreciation !== null && (
                            <span className={`shrink-0 text-[10px] font-bold ${appreciation >= 0 ? "text-green-600" : "text-red-600"}`}>
                              {appreciation >= 0 ? "+" : ""}{appreciation}%
                            </span>
                          )}
                          {t.bond && <span className="shrink-0 text-[10px] text-blue-500">Bond: {formatZAR(t.bond)}</span>}
                        </div>
                      );
                    })}
                  </div>
                  {d.transfer_history.length >= 2 && (() => {
                    const first = d.transfer_history[d.transfer_history.length - 1];
                    const last = d.transfer_history[0];
                    if (first?.price && last?.price && first.price > 0) {
                      const totalAppreciation = Math.round(((last.price / first.price) - 1) * 100);
                      const firstYear = parseInt(first.date || first.registration_date || "0");
                      const lastYear = parseInt(last.date || last.registration_date || "0");
                      const years = lastYear - firstYear;
                      const annualized = years > 0 ? (totalAppreciation / years).toFixed(1) : null;
                      return (
                        <p className="text-xs text-gray-500 mt-2">
                          Property value changed {totalAppreciation >= 0 ? "+" : ""}{totalAppreciation}% across {d.transfer_history.length} transfers
                          {annualized ? ` (~${annualized}%/year over ${years} years)` : ""}.
                          {p.asking_price && last.price ? ` Current asking is ${Math.round(((p.asking_price / last.price) - 1) * 100)}% ${p.asking_price >= last.price ? "above" : "below"} last transfer price.` : ""}
                        </p>
                      );
                    }
                    return null;
                  })()}
                </div>
              )}

              {/* Owner ID (if available, partially masked) */}
              {p.owner_id_number && (
                <div className="text-[10px] text-gray-400">Owner ID: {p.owner_id_number.substring(0, 6)}****{p.owner_id_number.slice(-2)}</div>
              )}
            </div>
          ) : (
            <div className="text-sm text-gray-400">
              <p>No deeds data yet.</p>
              <p className="text-[10px] mt-1">Deeds data is fetched automatically during report generation via Windeed/DeedsWeb. GVR data can be collected via the scraper page.</p>
            </div>
          )}
        </section>

        {/* ── CRIME ── */}
        <section className="bg-white border rounded-lg p-4">
          <div className="flex justify-between items-start mb-2">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="font-bold text-sm">Crime — {p.suburb || p.city}</h2>
                <FeedbackBtn propertyId={p.id} section="crime" />
              </div>
              <div className="text-[10px] text-gray-400">
                <a href="https://crimehub.org" target="_blank" rel="noreferrer" className="text-blue-500 hover:underline">CrimeHub</a> / <a href="https://www.saps.gov.za/services/crimestats.php" target="_blank" rel="noreferrer" className="text-blue-500 hover:underline">SAPS</a> &middot; verified &middot; 20 years of data
              </div>
            </div>
            <CollectBtn action="crime" label="Get Crime Data" ready={hasCrime} />
          </div>
          {(() => {
            // Check for CrimeHub detailed data first
            const crimeDetailed = data.area_risks?.find((r: A) => r.risk_type === "crime_detailed");
            const cd = crimeDetailed?.details ? (typeof crimeDetailed.details === "string" ? JSON.parse(crimeDetailed.details) : crimeDetailed.details) : null;

            if (cd) {
              // Real CrimeHub data
              const trendDirection = cd.trend_5yr && cd.trend_5yr[cd.trend_5yr.length - 1] < cd.trend_5yr[0] ? "improving" : "worsening";
              return (
                <div>
                  <div className="bg-gray-50 rounded p-3 mb-3 text-xs space-y-1">
                    <div><span className="text-gray-500">Police station:</span> <a href={cd.station_url} target="_blank" rel="noreferrer" className="text-blue-500 hover:underline capitalize">{cd.station_name}</a></div>
                    <div><span className="text-gray-500">Latest year:</span> {cd.latest_year} (April {parseInt(cd.latest_year) - 1} – March {cd.latest_year})</div>
                    <div><span className="text-gray-500">Total incidents:</span> <span className="font-bold text-base">{cd.total_latest?.toLocaleString()}</span></div>
                    {cd.rate_per_100k && <div><span className="text-gray-500">Rate per 100,000 people:</span> <span className="font-bold">{Math.round(cd.rate_per_100k).toLocaleString()}</span></div>}
                    {cd.trend_5yr && (
                      <div><span className="text-gray-500">5-year trend:</span>{" "}
                        <span className={trendDirection === "improving" ? "text-green-600 font-bold" : "text-red-600 font-bold"}>
                          {trendDirection === "improving" ? "Improving" : "Worsening"}
                        </span>
                        <span className="text-gray-400 ml-1">({cd.trend_years?.join(", ")}: {cd.trend_5yr.join(" → ")})</span>
                      </div>
                    )}
                  </div>

                  <h3 className="text-xs font-bold text-gray-600 mb-1">Crime by Category ({cd.latest_year})</h3>
                  <div className="space-y-0.5">
                    {cd.categories?.sort((a: A, b: A) => b.count - a.count).map((c: A, i: number) => (
                      <div key={i} className="flex justify-between items-center text-sm py-0.5 border-b border-gray-100">
                        <span className="capitalize">{c.type}</span>
                        <div className="flex items-center gap-2">
                          <div className="w-20 bg-gray-200 rounded-full h-1.5">
                            <div className="h-1.5 rounded-full bg-red-500" style={{ width: `${Math.min(100, (c.count / (cd.categories[0]?.count || 1)) * 100)}%` }} />
                          </div>
                          <span className="font-mono font-bold w-12 text-right">{c.count}</span>
                        </div>
                      </div>
                    ))}
                    <div className="flex justify-between font-bold pt-1 text-sm">
                      <span>Total</span>
                      <span>{cd.total_latest?.toLocaleString()}</span>
                    </div>
                  </div>
                  <div className="text-[9px] text-gray-400 mt-2">Source: <a href={cd.station_url} target="_blank" rel="noreferrer" className="text-blue-500">CrimeHub</a> — SAPS official statistics, verified</div>
                </div>
              );
            }

            return <p className="text-sm text-gray-400">Click Get Crime Data to pull verified SAPS statistics from CrimeHub for the nearest police station.</p>;
          })()}
        </section>

        {/* ── SOCIAL LISTENING ── */}
        <section className="bg-white border rounded-lg p-4">
          <div className="flex justify-between items-start mb-2">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="font-bold text-sm">Neighbourhood Pros and Cons</h2>
                <FeedbackBtn propertyId={p.id} section="neighbourhood" />
              </div>
              <div className="text-[10px] text-gray-400">
                Neighbourhood pros and cons from nearby reviews — noise, traffic, safety, amenities —{" "}
                <a href="https://developers.google.com/maps/documentation/places" target="_blank" rel="noreferrer" className="text-blue-500">Google Places API</a>
              </div>
            </div>
            <CollectBtn action="social" label="Scan Neighbourhood" ready={data.area_risks?.some((r: A) => r.risk_type === "social_concerns")} />
          </div>
          {(() => {
            const socialData = data.area_risks?.find((r: A) => r.risk_type === "social_concerns");
            if (!socialData?.details) return <p className="text-sm text-gray-400">Click Scan Neighbourhood to find pros and cons from nearby reviews.</p>;

            const details = typeof socialData.details === "string" ? JSON.parse(socialData.details) : socialData.details;
            const concerns = details.concerns || [];
            const positives = details.positives || [];

            return (
              <div>
                <div className="bg-gray-50 rounded p-2 mb-2 text-xs">
                  <span className="text-gray-500">Scanned {details.places_scanned} nearby places</span>
                  {concerns.length > 0 && <span className="ml-2 text-orange-600 font-bold">{concerns.length} concerns found</span>}
                  {positives.length > 0 && <span className="ml-2 text-green-600">{positives.length} positives</span>}
                </div>
                {concerns.length > 0 && (() => {
                  // Filter to area-relevant concerns (safety, noise, infrastructure — not hotel/restaurant service)
                  // Deduplicate by place name, then show top 5
                  const seen = new Set<string>();
                  const deduped = concerns.filter((c: A) => {
                    const key = (c.place || '') + (c.keywords || []).join(',');
                    if (seen.has(key)) return false;
                    seen.add(key);
                    return true;
                  });
                  const shown = deduped.slice(0, 5);
                  return (
                  <div className="space-y-2 mb-3">
                    <h3 className="text-xs font-bold text-orange-700">Area concerns from nearby reviews ({shown.length} of {concerns.length})</h3>
                    {shown.map((c: A, i: number) => (
                      <div key={i} className="bg-orange-50 border-l-3 border-orange-300 rounded p-2 text-xs" style={{ borderLeft: "3px solid #F59E0B" }}>
                        <div className="flex justify-between">
                          <span className="font-medium">{c.place}</span>
                          <span className="text-gray-400">{c.time}</span>
                        </div>
                        <p className="text-gray-700 mt-0.5">&ldquo;{c.review_text}&rdquo;</p>
                        <div className="flex gap-1 mt-1">
                          {c.keywords?.map((k: string, j: number) => (
                            <span key={j} className="bg-orange-200 text-orange-800 px-1.5 py-0.5 rounded text-[9px]">{k}</span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                  );
                })()}
                {positives.length > 0 && (
                  <div className="space-y-1">
                    <h3 className="text-xs font-bold text-green-700">Positive mentions</h3>
                    {positives.slice(0, 5).map((p2: A, i: number) => (
                      <div key={i} className="bg-green-50 rounded p-2 text-xs">
                        <span className="font-medium">{p2.place}</span>: &ldquo;{p2.review_text}&rdquo;
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}
        </section>

        {/* ── SECURITY & COMMUNITY ── */}
        <section className="bg-white border rounded-lg p-4">
          <div className="flex justify-between items-start mb-2">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="font-bold text-sm">Security &amp; Community</h2>
                <FeedbackBtn propertyId={p.id} section="security" />
              </div>
              <div className="text-[10px] text-gray-400">
                Armed response companies, CPF, neighbourhood watch — via{" "}
                <a href="https://developers.google.com/maps/documentation/places" target="_blank" rel="noreferrer" className="text-blue-500">Google Places API</a>
              </div>
            </div>
            <CollectBtn action="security" label="Collect Security Data" ready={data.area_risks?.some((r: A) => r.risk_type === "security_community")} />
          </div>
          {(() => {
            const secData = data.area_risks?.find((r: A) => r.risk_type === "security_community");
            if (!secData?.details) return <p className="text-sm text-gray-400">Click Collect Security Data to find armed response, CPF, and neighbourhood watch info.</p>;

            const details = typeof secData.details === "string" ? JSON.parse(secData.details) : secData.details;
            const companies = details.security_companies || [];
            const cpf = details.cpf || {};
            const nhw = details.neighbourhood_watch || {};
            const sentiment = details.sentiment || {};

            return (
              <div className="space-y-3">
                {/* Overall sentiment */}
                <div className={`rounded p-2 text-xs font-bold ${sentiment.overall === "GOOD" ? "bg-green-50 text-green-700" : sentiment.overall === "POOR" ? "bg-red-50 text-red-700" : "bg-yellow-50 text-yellow-700"}`}>
                  Security coverage: {sentiment.overall || "UNKNOWN"}
                  {sentiment.themes?.length > 0 && <span className="font-normal ml-2">— themes: {sentiment.themes.map((t: string) => t.replace(/_/g, " ")).join(", ")}</span>}
                </div>

                {/* Security companies */}
                {companies.length > 0 && (
                  <div>
                    <h3 className="text-xs font-bold mb-1">Security Companies (top {Math.min(5, companies.length)} of {companies.length})</h3>
                    <div className="space-y-2">
                      {companies.slice(0, 5).map((co: A, i: number) => (
                        <div key={i} className="bg-gray-50 rounded p-2 text-xs">
                          <div className="flex justify-between items-start">
                            <div>
                              <span className="font-bold">{co.name}</span>
                              {co.armed_response && <span className="ml-1.5 bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded text-[9px] font-bold">ARMED RESPONSE</span>}
                              {co.distance_km != null && <span className="ml-1.5 text-gray-400 text-[9px]">{co.distance_km} km away</span>}
                            </div>
                            <div className="flex gap-2 items-center shrink-0">
                              {co.rating && <span className="text-yellow-600 font-bold">{co.rating} ★</span>}
                              {co.review_count > 0 && <span className="text-gray-400">({co.review_count} reviews)</span>}
                            </div>
                          </div>
                          {co.phone && <div className="text-gray-500 mt-0.5">Phone: {co.phone}</div>}
                          {co.website && <a href={co.website} target="_blank" rel="noreferrer" className="text-blue-500 hover:underline mt-0.5 block truncate">{co.website}</a>}
                          {co.top_reviews?.length > 0 && (
                            <div className="mt-1 text-green-700 italic">&ldquo;{co.top_reviews[0]}&rdquo;</div>
                          )}
                          {co.complaints?.length > 0 && (
                            <div className="mt-1 text-red-600 italic">&ldquo;{co.complaints[0]}&rdquo;</div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* CPF */}
                <div className="flex gap-4">
                  <div className="flex-1 bg-gray-50 rounded p-2 text-xs">
                    <h3 className="font-bold mb-1">Community Policing Forum (CPF)</h3>
                    {cpf.name ? (
                      <div>
                        <div className="font-medium">{cpf.name}{cpf.distance_km != null && <span className="text-gray-400 font-normal text-[9px] ml-1">({cpf.distance_km} km)</span>}</div>
                        <div className={`text-[10px] ${cpf.activity_level === "active" ? "text-green-600" : cpf.activity_level === "moderate" ? "text-yellow-600" : "text-gray-400"}`}>
                          Activity: {cpf.activity_level}
                        </div>
                        {cpf.contact_phone && <div className="text-gray-500">Phone: {cpf.contact_phone}</div>}
                        {cpf.website_url && <a href={cpf.website_url} target="_blank" rel="noreferrer" className="text-blue-500 hover:underline block truncate">{cpf.website_url}</a>}
                        {cpf.facebook_url && <a href={cpf.facebook_url} target="_blank" rel="noreferrer" className="text-blue-500 hover:underline block truncate">Facebook page</a>}
                        {cpf.evidence && <div className="text-gray-400 mt-1">{cpf.evidence}</div>}
                      </div>
                    ) : <span className="text-gray-400">No CPF found nearby</span>}
                  </div>

                  {/* Neighbourhood Watch */}
                  <div className="flex-1 bg-gray-50 rounded p-2 text-xs">
                    <h3 className="font-bold mb-1">Neighbourhood Watch</h3>
                    {nhw.name ? (
                      <div>
                        <div className="font-medium">{nhw.name}{nhw.distance_km != null && <span className="text-gray-400 font-normal text-[9px] ml-1">({nhw.distance_km} km)</span>}</div>
                        <div className={`text-[10px] ${nhw.activity_level === "active" ? "text-green-600" : nhw.activity_level === "moderate" ? "text-yellow-600" : "text-gray-400"}`}>
                          Activity: {nhw.activity_level}
                        </div>
                        {nhw.contact_info && <div className="text-gray-500">Contact: {nhw.contact_info}</div>}
                        {nhw.facebook_url && <a href={nhw.facebook_url} target="_blank" rel="noreferrer" className="text-blue-500 hover:underline block truncate">Facebook page</a>}
                      </div>
                    ) : <span className="text-gray-400">No neighbourhood watch found nearby</span>}
                  </div>
                </div>

                {/* Sentiment details */}
                {(sentiment.positive?.length > 0 || sentiment.negative?.length > 0) && (
                  <div className="flex gap-4">
                    {sentiment.positive?.length > 0 && (
                      <div className="flex-1">
                        <h3 className="text-xs font-bold text-green-700 mb-1">Positive signals</h3>
                        {sentiment.positive.map((s: string, i: number) => (
                          <div key={i} className="bg-green-50 rounded p-1.5 text-xs mb-1">{s}</div>
                        ))}
                      </div>
                    )}
                    {sentiment.negative?.length > 0 && (
                      <div className="flex-1">
                        <h3 className="text-xs font-bold text-red-700 mb-1">Concerns</h3>
                        {sentiment.negative.map((s: string, i: number) => (
                          <div key={i} className="bg-red-50 rounded p-1.5 text-xs mb-1">{s}</div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })()}
        </section>

        {/* ── INFRASTRUCTURE & RISK ── */}
        <section className="bg-white border rounded-lg p-4">
          <div className="flex justify-between items-start mb-2">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="font-bold text-sm">Infrastructure &amp; Environmental Risk</h2>
                {sectionUpdated("solar_ghi_kwh_year", "water_quality_score") && <div className="text-[9px] text-gray-300">Updated: {sectionUpdated("solar_ghi_kwh_year", "water_quality_score")}</div>}
                <FeedbackBtn propertyId={p.id} section="infrastructure" />
              </div>
              <div className="text-[10px] text-gray-400">
                Data from <a href="https://ws.dws.gov.za" target="_blank" rel="noreferrer" className="text-blue-500">DWS</a>,{" "}
                <a href="https://maps.geoscience.org.za" target="_blank" rel="noreferrer" className="text-blue-500">CGS</a>,{" "}
                <a href="https://odp-cctegis.opendata.arcgis.com" target="_blank" rel="noreferrer" className="text-blue-500">Municipal GIS</a>
              </div>
            </div>
            <CollectBtn action="risk" label="Collect Risk Data" ready={p.water_quality_score != null || p.solar_ghi_kwh_year != null} />
          </div>
          <div className="space-y-2">
            {p.water_quality_score != null && (
              <div className="bg-gray-50 rounded p-2">
                <Datum label={`Water Quality — ${p.city || "unknown city"}`} value={`${p.water_quality_score}/10`} source={src("water_quality_score")} />
                <p className="text-xs text-gray-500 mt-1">{
                  p.water_quality_score >= 8 ? "Good — municipal water supply meets national standards. Safe for drinking."
                  : p.water_quality_score >= 5 ? "Moderate — water supply is functional but has some quality concerns. Consider a water filter."
                  : "Poor — water supply has serious quality issues. Install filtration. Check for pipe corrosion risk."
                }</p>
              </div>
            )}
            {p.sewerage_quality_score != null && (
              <div className={`rounded p-2 ${p.sewerage_quality_score <= 4 ? "bg-red-50" : "bg-gray-50"}`}>
                <Datum label={`Sewerage Quality — ${p.city || "unknown city"}`} value={`${p.sewerage_quality_score}/10`} source={src("sewerage_quality_score")} />
                <p className="text-xs text-gray-500 mt-1">{
                  p.sewerage_quality_score >= 7 ? "Good — sewerage infrastructure is well maintained. Low risk of backflows or contamination."
                  : p.sewerage_quality_score >= 4 ? "Concerning — sewerage treatment is below national standards. Some risk of overflows during heavy rain. Check for damp in lower areas of property."
                  : "Critical — sewerage infrastructure is failing in this municipality. High risk of sewage backflows, contaminated water, and bad smells. Major red flag for buyers."
                }</p>
              </div>
            )}
            {p.dolomite_risk && (
              <div className={`rounded p-2 ${p.dolomite_risk === "HIGH" || p.dolomite_risk === "CRITICAL" ? "bg-red-50" : "bg-gray-50"}`}>
                <Datum label="Dolomite / Sinkhole Risk" value={p.dolomite_risk} source={src("dolomite_risk")} />
                <p className="text-xs text-gray-500 mt-1">{
                  p.dolomite_risk === "CRITICAL" ? "Extreme risk — this area sits on dolomitic rock prone to sinkhole formation. Specialist geotechnical assessment essential before purchase. Insurance may be difficult to obtain."
                  : p.dolomite_risk === "HIGH" ? "High risk — sinkholes have occurred in this area. Get a geotechnical report. Check for any cracks in walls or floors. Ensure property has proper drainage to prevent water pooling."
                  : p.dolomite_risk === "MEDIUM" ? "Moderate risk — dolomite is present but controlled. Look for signs of ground movement: cracking walls, doors that don't close properly, uneven floors."
                  : "Low risk — dolomite is present in the broader area but risk to this property is limited."
                }</p>
              </div>
            )}
            {p.mining_subsidence_risk && (
              <div className={`rounded p-2 ${p.mining_subsidence_risk === "HIGH" ? "bg-red-50" : "bg-gray-50"}`}>
                <Datum label="Mining Subsidence" value={p.mining_subsidence_risk} source={src("mining_subsidence_risk")} />
                <p className="text-xs text-gray-500 mt-1">{
                  p.mining_subsidence_risk === "HIGH" ? "High risk — property is above or near historical mining operations. Ground may be unstable. Look for structural cracks, uneven floors, and difficulty closing doors. Specialist survey recommended."
                  : "Moderate risk — old mining activity in the broader area. Monitor for any signs of subsidence over time."
                }</p>
              </div>
            )}
            {p.flood_zone != null && p.flood_zone && (
              <div className="bg-orange-50 rounded p-2">
                <Datum label="Flood Zone" value={`Yes — ${p.flood_zone_type || "check municipal records"}`} source={src("flood_zone")} />
                <p className="text-xs text-gray-500 mt-1">Property is in or near a flood-prone area. This affects insurance premiums, may cause periodic water damage, and can reduce resale value. Check basement/ground floor for water marks.</p>
              </div>
            )}
            {p.flood_zone != null && !p.flood_zone && (
              <div className="bg-gray-50 rounded p-2">
                <Datum label="Flood Zone" value="No" source={src("flood_zone")} />
                <p className="text-xs text-gray-500 mt-1">Property is not in a known flood zone. Good for insurance rates.</p>
              </div>
            )}
            {p.heritage_site && (
              <div className="bg-yellow-50 rounded p-2">
                <Datum label="Heritage Area" value={`Yes${p.heritage_grade ? ` (Grade ${p.heritage_grade})` : ""}`} source={src("heritage_site")} />
                <p className="text-xs text-gray-500 mt-1">Property is in a heritage-protected area. Any renovations, alterations, or demolitions may require approval from the heritage authority. This can delay building projects and restrict what changes you can make. Good for preservation, but limits flexibility.</p>
              </div>
            )}
            {p.zoning && <div className="bg-gray-50 rounded p-2"><Datum label="Zoning" value={p.zoning} source={src("zoning")} /></div>}
            {p.loadshedding_group && <div className="bg-gray-50 rounded p-2"><Datum label="Load Shedding Group" value={p.loadshedding_group} source={src("loadshedding_group")} /></div>}
            {p.municipal_valuation != null && (
              <div className="bg-gray-50 rounded p-2">
                <Datum label="Municipal Valuation" value={formatZAR(p.municipal_valuation)} source={src("municipal_valuation")} />
                {p.asking_price && p.municipal_valuation && (
                  <p className="text-xs text-gray-500 mt-1">
                    {p.asking_price > p.municipal_valuation * 1.3
                      ? `Asking price is ${Math.round(((p.asking_price / p.municipal_valuation) - 1) * 100)}% above municipal valuation — this is a significant premium. Negotiate down.`
                      : p.asking_price > p.municipal_valuation
                      ? `Asking price is ${Math.round(((p.asking_price / p.municipal_valuation) - 1) * 100)}% above municipal valuation — slight premium, fairly normal.`
                      : `Asking price is below or at municipal valuation — potentially good value.`
                    }
                  </p>
                )}
              </div>
            )}
          </div>
          {p.solar_ghi_kwh_year && (
              <div className="bg-yellow-50 rounded p-2">
                <Datum label="Solar Irradiance (GHI)" value={`${Number(p.solar_ghi_kwh_year).toFixed(0)} kWh/m²/year`} source={src("solar_ghi_kwh_year")} />
                <Datum label="PV Output (1kWp system)" value={`${Number(p.solar_pv_output_kwh_year).toFixed(0)} kWh/year`} source={src("solar_pv_output_kwh_year")} />
                <p className="text-xs text-gray-600 mt-1 font-medium">{
                  (() => {
                    const ghi = Number(p.solar_ghi_kwh_year);
                    const pvOut = Number(p.solar_pv_output_kwh_year);
                    const savingsPerYear = Math.round(pvOut * 2.5); // ~R2.50/kWh avg Eskom tariff
                    if (ghi >= 1900) return `Outstanding solar location — a standard 5kWp system would generate ~${(pvOut * 5).toLocaleString()} kWh/year, saving roughly R${(savingsPerYear * 5).toLocaleString()}/year on electricity. This area receives more sun than 80% of South Africa.`;
                    if (ghi >= 1700) return `Excellent solar potential — a 5kWp system would generate ~${(pvOut * 5).toLocaleString()} kWh/year, saving roughly R${(savingsPerYear * 5).toLocaleString()}/year. Solar panels will pay for themselves within 4-5 years at current Eskom tariffs.`;
                    if (ghi >= 1500) return `Good solar potential — a 5kWp system would generate ~${(pvOut * 5).toLocaleString()} kWh/year, saving roughly R${(savingsPerYear * 5).toLocaleString()}/year. Viable for solar with a 5-7 year payback period.`;
                    return `Moderate solar — a 5kWp system would generate ~${(pvOut * 5).toLocaleString()} kWh/year, saving roughly R${(savingsPerYear * 5).toLocaleString()}/year. Below SA average but still worth considering given rising electricity costs.`;
                  })()
                }</p>
              </div>
            )}
            {!p.water_quality_score && !p.solar_ghi_kwh_year && !p.dolomite_risk && (
              <p className="text-sm text-gray-400 mt-1">Click Collect Risk Data to pull water quality, solar, geological, flood, and compliance data.</p>
            )}
        </section>

        {/* ── AFFORDABILITY & TRANSFER COSTS ── */}
        <section className="bg-white border rounded-lg p-4">
          <div className="flex items-center gap-2 mb-2">
            <h2 className="font-bold text-sm">What It Really Costs</h2>
            <FeedbackBtn propertyId={p.id} section="affordability" />
          </div>
          {!p.asking_price ? (
            <p className="text-sm text-gray-400">Asking price needed to calculate costs</p>
          ) : !aff ? (
            <p className="text-sm text-gray-400">Affordability data not available</p>
          ) : (
            <div className="space-y-4">
              {/* Market Value Comparison */}
              {aff.market_comparison?.comparisons?.length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold text-gray-600 mb-2">Market Value Comparison</h3>
                  <div className="space-y-2">
                    {aff.market_comparison.comparisons.map((c: A, i: number) => {
                      const color = c.verdict === 'fair' || c.verdict === 'below' ? 'bg-green-50 border-green-200 text-green-800'
                        : c.verdict === 'above' ? 'bg-yellow-50 border-yellow-200 text-yellow-800'
                        : 'bg-red-50 border-red-200 text-red-800';
                      return (
                        <div key={i} className={`rounded border p-2 ${color}`}>
                          <div className="flex justify-between items-center">
                            <span className="text-xs font-medium">{c.benchmark}</span>
                            <span className="text-xs font-bold">{formatZAR(c.value)}</span>
                          </div>
                          <div className="text-xs mt-1">
                            <span className="font-semibold">{c.diff_pct > 0 ? '+' : ''}{c.diff_pct}%</span>
                            {' '}<span className="opacity-80">{c.note}</span>
                          </div>
                        </div>
                      );
                    })}
                    {aff.market_comparison.overall_verdict && (
                      <div className={`text-xs font-semibold px-2 py-1 rounded ${
                        aff.market_comparison.overall_verdict === 'fair' ? 'bg-green-100 text-green-800'
                        : aff.market_comparison.overall_verdict === 'potential_bargain' ? 'bg-green-100 text-green-800'
                        : aff.market_comparison.overall_verdict === 'slightly_above' ? 'bg-yellow-100 text-yellow-800'
                        : 'bg-red-100 text-red-800'
                      }`}>
                        Overall: {aff.market_comparison.overall_verdict.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase())}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Once-off Costs Table */}
              <div>
                <h3 className="text-xs font-semibold text-gray-600 mb-2">Once-off Purchase Costs</h3>
                <div className="bg-gray-50 rounded p-3">
                  <table className="w-full text-xs">
                    <tbody>
                      <tr className="border-b border-gray-200"><td className="py-1.5 text-gray-600">Transfer Duty</td><td className="py-1.5 text-right font-medium">{formatZAR(aff.transfer_duty)}</td></tr>
                      <tr className="border-b border-gray-200"><td className="py-1.5 text-gray-600">Conveyancing Fees</td><td className="py-1.5 text-right font-medium">{formatZAR(aff.conveyancing_fees)}</td></tr>
                      <tr className="border-b border-gray-200"><td className="py-1.5 text-gray-600">Bond Attorney Fees</td><td className="py-1.5 text-right font-medium">{formatZAR(aff.bond_attorney_fees)}</td></tr>
                      <tr className="border-b border-gray-200"><td className="py-1.5 text-gray-600">Deeds Office</td><td className="py-1.5 text-right font-medium">{formatZAR(aff.deeds_office_fees)}</td></tr>
                      <tr className="border-b border-gray-200"><td className="py-1.5 text-gray-600">Bank Initiation Fee</td><td className="py-1.5 text-right font-medium">{formatZAR(aff.bank_initiation_fee)}</td></tr>
                      {aff.deposit > 0 && <tr className="border-b border-gray-200"><td className="py-1.5 text-gray-600">Deposit</td><td className="py-1.5 text-right font-medium">{formatZAR(aff.deposit)}</td></tr>}
                      <tr className="font-bold border-t-2 border-gray-300"><td className="py-2">TOTAL Cash Needed Upfront</td><td className="py-2 text-right">{formatZAR(aff.total_once_off)}</td></tr>
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Monthly Costs */}
              <div>
                <h3 className="text-xs font-semibold text-gray-600 mb-2">Monthly Costs</h3>
                <div className="bg-blue-50 rounded p-3">
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-gray-700">Bond Payment <span className="text-[10px] text-gray-400">(at {aff.interest_rate}% over {aff.term_years} years)</span></span>
                    <span className="text-lg font-bold text-blue-800">{formatZAR(aff.monthly_bond_payment)}</span>
                  </div>
                </div>
              </div>

              {/* True Cost */}
              <div>
                <h3 className="text-xs font-semibold text-gray-600 mb-2">True Cost Over {aff.term_years} Years</h3>
                <div className="bg-orange-50 rounded p-3 space-y-1">
                  <div className="flex justify-between text-xs"><span className="text-gray-600">Purchase Price</span><span className="font-medium">{formatZAR(aff.purchase_price)}</span></div>
                  <div className="flex justify-between text-xs"><span className="text-gray-600">Total Interest Paid</span><span className="font-medium text-orange-700">{formatZAR(aff.total_interest_over_term)}</span></div>
                  <div className="flex justify-between text-xs"><span className="text-gray-600">Once-off Costs</span><span className="font-medium">{formatZAR(aff.total_once_off)}</span></div>
                  <div className="flex justify-between text-sm font-bold border-t border-orange-200 pt-2 mt-1"><span>True Cost</span><span className="text-orange-800">{formatZAR(aff.true_cost)}</span></div>
                </div>
              </div>
            </div>
          )}
        </section>

        {/* ── COMPLIANCE CERTIFICATES ── */}
        {p.electrical_coc_required != null && (
          <section className="bg-white border rounded-lg p-4">
            <h2 className="font-bold text-sm">Compliance Certificates Required for Transfer</h2>
            <div className="text-[10px] text-gray-400 mb-2">
              <a href="https://www.sahomeloans.com/bond-talk/guide-compliance-certificates" target="_blank" rel="noreferrer" className="text-blue-500">SA National Building Regulations</a> &middot; Required by law for property transfer
            </div>
            <div className="space-y-2">
              {[
                { label: "Electrical CoC", needed: p.electrical_coc_required, src: "OHS Act 1993", cost: "R2,500", explain: "Required for every property transfer. The seller must provide a valid certificate (less than 2 years old) confirming the electrical installation is safe. If the installation fails, the seller pays for repairs." },
                { label: "Plumbing CoC", needed: p.plumbing_coc_required, src: "Cape Town by-laws", cost: "R1,500", explain: "Required in Cape Town for all property transfers. Confirms plumbing meets municipal standards. Common failures: leaking taps, non-compliant geyser installations, incorrect pipe sizing." },
                { label: "Beetle Certificate", needed: p.beetle_cert_required, src: "WC/KZN requirement", cost: "R1,200", explain: "Required in Western Cape and KZN. Confirms the property is free from wood-boring beetles. If beetles are found, treatment costs R3,000-R15,000 depending on severity." },
                { label: "Gas CoC", needed: p.gas_coc_required, src: "Pressure Equipment Regs", cost: "R800", explain: "Required if the property has any gas installation (stove, heater, braai). Must be issued by a registered gas installer." },
                { label: "Electric Fence CoC", needed: p.electric_fence_coc_required, src: "OHS Act", cost: "R1,500", explain: "Required if the property has an electric fence. Must comply with SANS 10222-3. Non-compliant fences must be upgraded at seller's expense." },
              ].filter(c => c.needed).map(c => (
                <div key={c.label} className="bg-yellow-50 border border-yellow-200 rounded p-3 text-xs">
                  <div className="flex justify-between items-center">
                    <div className="font-bold text-yellow-800">{c.label} <span className="font-normal text-yellow-600">— {c.src}</span></div>
                    {"cost" in c && <span className="font-bold text-yellow-800">{(c as any).cost}</span>}
                  </div>
                  <p className="text-yellow-700 mt-1">{c.explain}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ── SCHOOLS & CLIMATE (from new scrapers) ── */}
        <section className="bg-white border rounded-lg p-4">
          <div className="flex justify-between items-center mb-2">
            <h2 className="font-bold text-sm">Schools Nearby</h2>
            <CollectBtn action="schools" label="Get Schools" ready={data.area_risks?.some((r: A) => r.risk_type === "school_proximity")} />
          </div>
        {data.area_risks?.some((r: A) => r.risk_type === "school_proximity") ? (
          <div>
            {data.area_risks.filter((r: A) => r.risk_type === "school_proximity").map((r: A, i: number) => {
              const d = typeof r.details === "string" ? JSON.parse(r.details) : r.details;
              return (
                <div key={i}>
                  <div className="flex gap-4 mt-2 mb-2">
                    <div className="bg-gray-50 rounded p-2 text-center"><div className="text-xl font-bold">{r.risk_score}/10</div><div className="text-[9px] text-gray-500">School Score</div></div>
                    <div className="bg-gray-50 rounded p-2 text-center"><div className="text-xl font-bold">{d?.total_found || d?.schools?.length || 0}</div><div className="text-[9px] text-gray-500">Within 3km</div></div>
                    <div className="bg-gray-50 rounded p-2 text-center"><div className="text-xl font-bold">{d?.within_1km || 0}</div><div className="text-[9px] text-gray-500">Within 1km</div></div>
                  </div>
                  {d?.schools?.slice(0, 5).map((s: A, si: number) => (
                    <div key={si} className="flex justify-between text-xs border-b border-gray-100 py-1">
                      <span>{s.name}</span>
                      <span className="text-gray-400">{s.distance_km}km{s.rating ? ` · ${s.rating} stars` : ""}</span>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        ) : <p className="text-xs text-gray-400">No school data yet. Click Get Schools to find schools within 3km.</p>}
        </section>

        <section className="bg-white border rounded-lg p-4">
          <div className="flex justify-between items-center mb-2">
            <h2 className="font-bold text-sm">Climate Profile</h2>
            <CollectBtn action="climate" label="Get Climate" ready={data.area_risks?.some((r: A) => r.risk_type === "climate")} />
          </div>
        {data.area_risks?.some((r: A) => r.risk_type === "climate") ? (
          <div>
            {data.area_risks.filter((r: A) => r.risk_type === "climate").map((r: A, i: number) => {
              const d = typeof r.details === "string" ? JSON.parse(r.details) : r.details;
              if (!d) return null;
              return (
                <div key={i}>
                  <div className="grid grid-cols-4 gap-2 mt-2">
                    <div className="bg-gray-50 rounded p-2 text-center"><div className="text-lg font-bold">{d.annual_rainfall_mm}mm</div><div className="text-[9px] text-gray-500">Annual Rain</div></div>
                    <div className="bg-gray-50 rounded p-2 text-center"><div className="text-lg font-bold">{d.avg_humidity}%</div><div className="text-[9px] text-gray-500">Avg Humidity</div></div>
                    <div className={`rounded p-2 text-center ${d.damp_risk === "HIGH" ? "bg-red-50" : "bg-gray-50"}`}><div className="text-lg font-bold">{d.damp_risk}</div><div className="text-[9px] text-gray-500">Damp Risk</div></div>
                    <div className="bg-gray-50 rounded p-2 text-center"><div className="text-lg font-bold">{d.climate_zone?.replace(/_/g, " ")}</div><div className="text-[9px] text-gray-500">Zone</div></div>
                  </div>
                  <div className="grid grid-cols-4 gap-2 mt-2">
                    {d.max_wind_speed_kmh && <div className={`rounded p-2 text-center ${d.max_wind_speed_kmh > 80 ? "bg-orange-50" : "bg-gray-50"}`}><div className="text-lg font-bold">{d.max_wind_speed_kmh} km/h</div><div className="text-[9px] text-gray-500">Max Wind</div></div>}
                    {d.avg_wind_speed_kmh && <div className="bg-gray-50 rounded p-2 text-center"><div className="text-lg font-bold">{d.avg_wind_speed_kmh} km/h</div><div className="text-[9px] text-gray-500">Avg Wind</div></div>}
                    {d.frost_days_per_year != null && <div className={`rounded p-2 text-center ${d.frost_days_per_year > 10 ? "bg-blue-50" : "bg-gray-50"}`}><div className="text-lg font-bold">{d.frost_days_per_year}</div><div className="text-[9px] text-gray-500">Frost Days/yr</div></div>}
                    {d.wind_risk && <div className={`rounded p-2 text-center ${d.wind_risk === "HIGH" ? "bg-orange-50" : "bg-gray-50"}`}><div className="text-lg font-bold">{d.wind_risk}</div><div className="text-[9px] text-gray-500">Wind Risk</div></div>}
                  </div>
                  <p className="text-xs text-gray-500 mt-2">{
                    d.damp_risk === "HIGH" ? "High damp risk — expect moisture issues. Check for mould, peeling paint, and damp patches on walls. Budget for damp-proofing treatment." :
                    d.frost_days_per_year > 20 ? "Significant frost — exposed pipes at risk of freezing. Check geyser insulation and exterior plumbing." :
                    d.max_wind_speed_kmh > 80 ? "Strong winds — check roof condition, boundary walls, and outdoor structures for wind damage resistance." :
                    "Climate conditions are moderate for this area."
                  }</p>
                </div>
              );
            })}
          </div>
        ) : <p className="text-xs text-gray-400">No climate data yet. Click Get Climate to pull 5-year weather history.</p>}
        </section>

        {/* ── SOLD PRICES ── */}
        <section className="bg-white border rounded-lg p-4">
          <div className="flex justify-between items-center mb-2">
            <h2 className="font-bold text-sm">Recent Sold Prices — {p.suburb}</h2>
            <CollectBtn action="soldprices" label="Get Sold Prices" ready={data.area_risks?.some((r: A) => r.risk_type === "sold_prices")} />
          </div>
        {data.area_risks?.some((r: A) => r.risk_type === "sold_prices") ? (
          <div>
            {data.area_risks.filter((r: A) => r.risk_type === "sold_prices").map((r: A, i: number) => {
              const d = typeof r.details === "string" ? JSON.parse(r.details) : r.details;
              if (!d) return null;
              return (
                <div key={i}>
                  <div className="flex gap-4 mb-2">
                    {d.avg_price && <div className="bg-gray-50 rounded p-2 text-center flex-1"><div className="text-lg font-bold">{formatZAR(d.avg_price)}</div><div className="text-[9px] text-gray-500">Average Sale Price</div></div>}
                    {d.median_price && <div className="bg-gray-50 rounded p-2 text-center flex-1"><div className="text-lg font-bold">{formatZAR(d.median_price)}</div><div className="text-[9px] text-gray-500">Median Sale Price</div></div>}
                    {d.total_sales && <div className="bg-gray-50 rounded p-2 text-center flex-1"><div className="text-lg font-bold">{d.total_sales}</div><div className="text-[9px] text-gray-500">Sales Recorded</div></div>}
                    {d.avg_price_per_sqm && <div className="bg-gray-50 rounded p-2 text-center flex-1"><div className="text-lg font-bold">{formatZAR(d.avg_price_per_sqm)}</div><div className="text-[9px] text-gray-500">Per m²</div></div>}
                  </div>
                  {p.asking_price && d.median_price && (
                    <p className="text-xs text-gray-600">{
                      p.asking_price > d.median_price * 1.15
                        ? `Asking price is ${Math.round(((p.asking_price / d.median_price) - 1) * 100)}% above the suburb median — negotiate hard.`
                        : p.asking_price < d.median_price * 0.9
                        ? `Asking price is ${Math.round((1 - (p.asking_price / d.median_price)) * 100)}% below the suburb median — potential bargain or an issue to investigate.`
                        : `Asking price is in line with the suburb median — fair market pricing.`
                    }</p>
                  )}
                  {d.recent_sales && Array.isArray(d.recent_sales) && d.recent_sales.length > 0 && (
                    <div className="mt-2">
                      {d.recent_sales.slice(0, 5).map((s: A, si: number) => (
                        <div key={si} className="flex justify-between text-xs border-b border-gray-100 py-1">
                          <span className="truncate flex-1">{s.address || s.description || "Property"}</span>
                          <span className="text-gray-500 shrink-0 ml-2">{s.bedrooms ? `${s.bedrooms}bed ` : ""}{s.size_sqm ? `${s.size_sqm}m² ` : ""}</span>
                          <span className="font-medium shrink-0 ml-2">{s.price ? formatZAR(s.price) : "—"}</span>
                          {s.sold_date && <span className="text-gray-400 shrink-0 ml-2">{formatDate(s.sold_date)}</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : <p className="text-xs text-gray-400">No sold price data yet. Click Get Sold Prices to find recent sales in this suburb.</p>}
        </section>

        {/* ── SUBURB MARKET TRENDS ── */}
        <section className="bg-white border rounded-lg p-4">
          <div className="flex justify-between items-center mb-2">
            <h2 className="font-bold text-sm">Suburb Market Trends — {p.suburb}</h2>
            <CollectBtn action="pricetrends" label="Get Trends" ready={data.area_risks?.some((r: A) => r.risk_type === "price_trends")} />
          </div>
        {data.area_risks?.some((r: A) => r.risk_type === "price_trends") ? (
          <div>
            {data.area_risks.filter((r: A) => r.risk_type === "price_trends").map((r: A, i: number) => {
              const d = typeof r.details === "string" ? JSON.parse(r.details) : r.details;
              if (!d) return null;
              const int = d.internal_data;
              const reg = d.regional_trend;
              const mkt = d.market_context;
              return (
                <div key={i}>
                  {/* Key metrics */}
                  <div className="flex gap-3 mb-3">
                    {int?.avg_price && <div className="bg-gray-50 rounded p-2 text-center flex-1"><div className="text-lg font-bold">{formatZAR(int.avg_price)}</div><div className="text-[9px] text-gray-500">Avg Asking</div></div>}
                    {int?.median_price && <div className="bg-gray-50 rounded p-2 text-center flex-1"><div className="text-lg font-bold">{formatZAR(int.median_price)}</div><div className="text-[9px] text-gray-500">Median</div></div>}
                    {int?.price_per_sqm && <div className="bg-gray-50 rounded p-2 text-center flex-1"><div className="text-lg font-bold">{formatZAR(int.price_per_sqm)}</div><div className="text-[9px] text-gray-500">Per m&#178;</div></div>}
                    {int?.total_listings && <div className="bg-gray-50 rounded p-2 text-center flex-1"><div className="text-lg font-bold">{int.total_listings}</div><div className="text-[9px] text-gray-500">Listings</div></div>}
                    {reg?.yoy_pct != null && (
                      <div className={`rounded p-2 text-center flex-1 ${reg.yoy_pct > 3 ? "bg-green-50" : reg.yoy_pct > 0 ? "bg-blue-50" : "bg-red-50"}`}>
                        <div className="text-lg font-bold">{reg.yoy_pct > 0 ? "+" : ""}{reg.yoy_pct}%</div>
                        <div className="text-[9px] text-gray-500">YoY Growth</div>
                      </div>
                    )}
                  </div>
                  {/* Regional trend */}
                  {reg && (
                    <div className={`rounded p-2 mb-2 text-xs ${reg.trend === "strong_growth" ? "bg-green-50 text-green-800" : reg.trend === "moderate_growth" ? "bg-blue-50 text-blue-800" : "bg-gray-50 text-gray-700"}`}>
                      <span className="font-bold capitalize">{(reg.trend || "").replace(/_/g, " ")}</span>
                      {reg.note && <span> — {reg.note}</span>}
                    </div>
                  )}
                  {/* Price by bedrooms */}
                  {int?.price_by_bedrooms && Object.keys(int.price_by_bedrooms).length > 0 && (
                    <div className="mb-2">
                      <div className="text-[10px] text-gray-500 mb-1 font-semibold">Price by bedrooms</div>
                      <div className="flex gap-2">
                        {Object.entries(int.price_by_bedrooms).sort(([a], [b]) => Number(a) - Number(b)).map(([beds, info]: [string, any]) => (
                          <div key={beds} className="bg-gray-50 rounded p-1.5 text-center flex-1">
                            <div className="text-xs font-bold">{formatZAR(info.median)}</div>
                            <div className="text-[8px] text-gray-400">{beds === "unknown" ? "?" : beds} bed ({info.count})</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {/* Market context */}
                  {mkt?.key_factors && (
                    <div className="mt-2 border-t pt-2">
                      <div className="text-[10px] text-gray-500 font-semibold mb-1">SA Market Context (Prime: {mkt.prime_rate}%, HPI: +{mkt.house_price_inflation}%)</div>
                      <div className="grid grid-cols-2 gap-1">
                        {mkt.key_factors.slice(0, 4).map((f: string, fi: number) => (
                          <div key={fi} className="text-[10px] text-gray-500 bg-gray-50 rounded px-2 py-1">{f}</div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : <p className="text-xs text-gray-400">No market trend data yet. Click Get Trends to analyse suburb pricing and regional growth.</p>}
        </section>

        {/* ── ELECTRICITY & LOAD SHEDDING ── */}
        <section className="bg-white border rounded-lg p-4">
          <div className="flex justify-between items-center mb-2">
            <h2 className="font-bold text-sm">Electricity</h2>
            <CollectBtn action="electricity" label="Get Electricity Data" ready={data.area_risks?.some((r: A) => r.risk_type === "electricity" || r.risk_type === "loadshedding")} />
          </div>
        {/* Electricity cost estimate */}
        {data.area_risks?.some((r: A) => r.risk_type === "electricity") && (() => {
          const elec = data.area_risks.find((r: A) => r.risk_type === "electricity");
          const d = typeof elec?.details === "string" ? JSON.parse(elec.details) : elec?.details;
          if (!d) return null;
          return (
            <div className="mb-3">
              <div className="flex gap-4 mb-2">
                <div className="bg-yellow-50 rounded p-2 text-center flex-1"><div className="text-lg font-bold">R{d.rate_per_kwh_rands}/kWh</div><div className="text-[9px] text-gray-500">Tariff Rate</div></div>
                <div className="bg-yellow-50 rounded p-2 text-center flex-1"><div className="text-lg font-bold">R{d.monthly_total_rands?.toLocaleString()}</div><div className="text-[9px] text-gray-500">Est. Monthly</div></div>
                <div className="bg-yellow-50 rounded p-2 text-center flex-1"><div className="text-lg font-bold">R{d.annual_total_rands?.toLocaleString()}</div><div className="text-[9px] text-gray-500">Est. Annual</div></div>
                <div className={`rounded p-2 text-center flex-1 ${d.load_shedding_stage > 0 ? "bg-red-50" : "bg-green-50"}`}><div className="text-lg font-bold">{d.load_shedding_status || "Unknown"}</div><div className="text-[9px] text-gray-500">Load Shedding</div></div>
              </div>
              <p className="text-xs text-gray-500">Supplier: {d.supplier}. Based on {d.estimated_bedrooms}-bedroom home using ~{d.estimated_monthly_kwh} kWh/month. Source: {d.tariff_source}.</p>
            </div>
          );
        })()}

        {/* Load shedding schedule (if separate data exists) */}
        {data.area_risks?.some((r: A) => r.risk_type === "loadshedding") ? (
          <div>
            {data.area_risks.filter((r: A) => r.risk_type === "loadshedding").map((r: A, i: number) => {
              const d = typeof r.details === "string" ? JSON.parse(r.details) : r.details;
              if (!d) return null;
              return (
                <div key={i}>
                  <div className="flex gap-4 mb-2">
                    {d.group && <div className="bg-gray-50 rounded p-2 text-center flex-1"><div className="text-lg font-bold">Group {d.group}</div><div className="text-[9px] text-gray-500">Schedule Group</div></div>}
                    {d.area && <div className="bg-gray-50 rounded p-2 text-center flex-1"><div className="text-lg font-bold truncate">{d.area}</div><div className="text-[9px] text-gray-500">EskomSePush Area</div></div>}
                    {r.risk_level && <div className={`rounded p-2 text-center flex-1 ${r.risk_level === "HIGH" || r.risk_level === "CRITICAL" ? "bg-red-50" : "bg-gray-50"}`}><div className="text-lg font-bold">{r.risk_level}</div><div className="text-[9px] text-gray-500">Impact Level</div></div>}
                  </div>
                  {d.schedule && Array.isArray(d.schedule) && d.schedule.length > 0 && (
                    <div className="space-y-0.5">
                      {d.schedule.slice(0, 4).map((slot: A, si: number) => (
                        <div key={si} className="flex justify-between text-xs bg-gray-50 rounded px-2 py-1">
                          <span>{slot.day || slot.date}</span>
                          <span className="text-gray-500">{slot.start}–{slot.end}</span>
                          <span className="font-medium">Stage {slot.stage}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  <p className="text-xs text-gray-500 mt-2">Load shedding affects property value — buyers increasingly factor in solar-readiness and backup power availability.</p>
                </div>
              );
            })}
          </div>
        ) : !data.area_risks?.some((r: A) => r.risk_type === "electricity") && <p className="text-xs text-gray-400">No electricity data yet. Click Get Electricity Data for tariff rates, cost estimates, and load shedding status.</p>}
        </section>

        {/* ── FIBRE COVERAGE ── */}
        <section className="bg-white border rounded-lg p-4">
          <div className="flex justify-between items-center mb-2">
            <h2 className="font-bold text-sm">Fibre Internet Coverage</h2>
            <CollectBtn action="fibre" label="Get Fibre Data" ready={data.area_risks?.some((r: A) => r.risk_type === "fibre_coverage")} />
          </div>
        {data.area_risks?.some((r: A) => r.risk_type === "fibre_coverage") ? (
          <div>
            {data.area_risks.filter((r: A) => r.risk_type === "fibre_coverage").map((r: A, i: number) => {
              const d = typeof r.details === "string" ? JSON.parse(r.details) : r.details;
              if (!d) return null;
              const providers = d.providers || d.isps || [];
              return (
                <div key={i}>
                  <div className="flex gap-4 mb-2">
                    <div className={`rounded p-2 text-center flex-1 ${r.risk_level === "HIGH" ? "bg-green-50" : r.risk_level === "MEDIUM" ? "bg-yellow-50" : "bg-gray-50"}`}>
                      <div className="text-lg font-bold">{r.risk_level === "HIGH" ? "Excellent" : r.risk_level === "MEDIUM" ? "Available" : r.risk_level === "LOW" ? "Limited" : r.risk_level || "Unknown"}</div>
                      <div className="text-[9px] text-gray-500">Coverage</div>
                    </div>
                    {providers.length > 0 && <div className="bg-gray-50 rounded p-2 text-center flex-1"><div className="text-lg font-bold">{providers.length}</div><div className="text-[9px] text-gray-500">Providers</div></div>}
                    {(d.max_speed || d.max_speed_mbps) && <div className="bg-gray-50 rounded p-2 text-center flex-1"><div className="text-lg font-bold">{d.max_speed || d.max_speed_mbps}Mbps</div><div className="text-[9px] text-gray-500">Max Speed</div></div>}
                  </div>
                  {providers.length > 0 && (
                    <div className="space-y-0.5">
                      {providers.map((prov: A, pi: number) => (
                        <div key={pi} className="flex justify-between text-xs bg-gray-50 rounded px-2 py-1">
                          <span className="font-medium">{prov.name || prov.isp}</span>
                          {prov.technology && <span className="text-gray-400">{prov.technology}</span>}
                          {(prov.max_speed || prov.speed) && <span className="text-gray-500">{prov.max_speed || prov.speed}Mbps</span>}
                          {prov.available !== undefined && <span className={prov.available ? "text-green-600" : "text-red-500"}>{prov.available ? "Available" : "Not available"}</span>}
                        </div>
                      ))}
                    </div>
                  )}
                  <p className="text-xs text-gray-500 mt-2">Fibre availability significantly impacts property desirability, especially for remote workers. Properties with fibre sell for 3-5% more.</p>
                </div>
              );
            })}
          </div>
        ) : <p className="text-xs text-gray-400">No fibre data yet. Click Get Fibre Data to check ISP coverage.</p>}
        </section>

        {/* ── MAINTENANCE COST & SERVICE PROVIDERS ── */}
        {(() => {
          // Calculate maintenance costs from vision findings
          let totalMin = 0, totalMax = 0;
          const repairsByTrade: Record<string, { items: A[]; min: number; max: number }> = {};
          const tradeMap: Record<string, string> = {
            roof: 'builder', walls: 'builder', structure: 'builder', extension: 'builder',
            damp: 'builder', plumbing: 'plumber', electrical: 'electrician',
            ceiling: 'painter', cosmetic: 'painter', environment: 'builder',
          };

          for (const f of findings) {
            const cost = f.estimated_repair_cost_zar || {};
            if (cost.max > 0) {
              totalMin += cost.min || 0;
              totalMax += cost.max || 0;
              const trade = tradeMap[f.category] || 'builder';
              if (!repairsByTrade[trade]) repairsByTrade[trade] = { items: [], min: 0, max: 0 };
              repairsByTrade[trade].items.push(f);
              repairsByTrade[trade].min += cost.min || 0;
              repairsByTrade[trade].max += cost.max || 0;
            }
          }

          const providers = data.service_providers || [];
          const hasRepairs = totalMax > 0;
          const hasProviders = providers.length > 0;

          if (!hasRepairs && !hasProviders) return null;

          return (
            <section className="bg-white border rounded-lg p-4">
              <h2 className="font-bold text-sm">Maintenance Cost Estimate & Service Providers</h2>
              <div className="text-[10px] text-gray-400 mb-3">Based on vision analysis findings — estimates only, get quotes from local providers</div>

              {hasRepairs && (
                <>
                  {/* Total cost summary */}
                  <div className="flex gap-3 mb-3">
                    <div className="bg-orange-50 rounded-lg p-3 flex-1 text-center">
                      <div className="text-[10px] text-gray-500">Estimated Total</div>
                      <div className="text-xl font-bold text-orange-700">{formatZAR(totalMin)} – {formatZAR(totalMax)}</div>
                    </div>
                    <div className="bg-gray-50 rounded-lg p-3 flex-1 text-center">
                      <div className="text-[10px] text-gray-500">Items Needing Attention</div>
                      <div className="text-xl font-bold">{Object.values(repairsByTrade).reduce((s, t) => s + t.items.length, 0)}</div>
                    </div>
                    <div className="bg-gray-50 rounded-lg p-3 flex-1 text-center">
                      <div className="text-[10px] text-gray-500">Trades Needed</div>
                      <div className="text-xl font-bold">{Object.keys(repairsByTrade).length}</div>
                    </div>
                  </div>

                  {/* Breakdown by trade */}
                  <div className="space-y-2 mb-4">
                    {Object.entries(repairsByTrade).sort((a, b) => b[1].max - a[1].max).map(([trade, data]) => (
                      <div key={trade} className="bg-gray-50 rounded p-2">
                        <div className="flex justify-between items-center">
                          <span className="text-xs font-bold capitalize">{trade}</span>
                          <span className="text-xs text-orange-700 font-bold">{formatZAR(data.min)} – {formatZAR(data.max)}</span>
                        </div>
                        <div className="text-[10px] text-gray-500 mt-0.5">{data.items.length} item{data.items.length !== 1 ? 's' : ''}: {data.items.slice(0, 2).map((f: A) => f.observation?.substring(0, 50) + '...').join('; ')}</div>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {/* Service providers */}
              {hasProviders && (
                <>
                  <h3 className="text-xs font-bold mb-2">Local Service Providers in {p.city}</h3>
                  <div className="grid grid-cols-2 gap-2">
                    {(() => {
                      // Show providers matching needed trades first, then others
                      const neededTrades = new Set(Object.keys(repairsByTrade));
                      const sorted = [...providers].sort((a: A, b: A) => {
                        const aNeeded = neededTrades.has(a.trade) ? 1 : 0;
                        const bNeeded = neededTrades.has(b.trade) ? 1 : 0;
                        return bNeeded - aNeeded || (b.rating || 0) - (a.rating || 0);
                      });
                      return sorted.slice(0, 10).map((sp: A, i: number) => (
                        <div key={i} className="bg-gray-50 rounded p-2 text-xs">
                          <div className="flex justify-between">
                            <span className="font-bold">{sp.name}</span>
                            {sp.rating && <span className="text-yellow-600">{sp.rating} ★ ({sp.review_count})</span>}
                          </div>
                          <div className="flex justify-between mt-0.5">
                            <span className="capitalize text-gray-500">{sp.trade}</span>
                            {neededTrades.has(sp.trade) && <span className="text-[9px] bg-orange-100 text-orange-700 px-1 rounded font-bold">NEEDED</span>}
                          </div>
                          {sp.phone && <div className="text-gray-400 mt-0.5">{sp.phone}</div>}
                        </div>
                      ));
                    })()}
                  </div>
                </>
              )}
            </section>
          );
        })()}

        {/* ── LISTING DATA ── */}
        <section className="bg-white border rounded-lg p-4">
          <h2 className="font-bold text-sm">Listing Data</h2>
          {sectionUpdated("listing_url", "erf_number", "suburb", "city") && <div className="text-[9px] text-gray-300">Updated: {sectionUpdated("listing_url", "erf_number", "suburb", "city")}</div>}
          <div className="text-[10px] text-gray-400 mb-2">Every field linked to its exact source page</div>
          <div className="grid grid-cols-2 gap-x-6">
            <Datum label="Listing Number" value={p.listing_number} source={src("listing_number")} />
            <Datum label="ERF Number" value={p.erf_number} source={src("erf_number")} />
            {p.street_address && <Datum label="Street Address" value={p.street_address} source={src("street_address")} />}
            <Datum label="Suburb" value={p.suburb} source={src("suburb")} />
            <Datum label="City" value={p.city} source={src("city")} />
            <Datum label="Province" value={p.province} source={src("province")} />
            {p.listing_date && <Datum label="Listing Date" value={formatDate(p.listing_date)} source={src("listing_date")} />}
            {p.listing_status && <Datum label="Listing Status" value={p.listing_status === "under_offer" ? "Under Offer" : p.listing_status === "price_reduced" ? "Price Reduced" : p.listing_status.charAt(0).toUpperCase() + p.listing_status.slice(1)} source={{ name: "PrivateProperty", confidence: "scraped" }} />}
            {p.property_type && <Datum label="Property Type" value={p.property_type} source={src("property_type")} />}
            {p.first_scraped_at && <Datum label="First Scraped" value={formatDate(p.first_scraped_at)} source={{ name: "Surepath", confidence: "verified" }} />}
            {p.last_checked_at && <Datum label="Last Checked" value={formatDate(p.last_checked_at)} source={{ name: "Surepath", confidence: "verified" }} />}
            {p.listing_date && (() => { const days = Math.floor((Date.now() - new Date(p.listing_date).getTime()) / 86400000); return days > 0 ? <Datum label="Days on Market" value={`${days} days`} source={{ name: "Calculated", confidence: "estimated" }} /> : null; })()}
          </div>
        </section>

        {/* ── PRICING ── */}
        {(p.asking_price || p.levies || p.rates_and_taxes) ? (
          <section className="bg-white border rounded-lg p-4">
            <h2 className="font-bold text-sm">Pricing &amp; Costs</h2>
            <div className="grid grid-cols-2 gap-x-6">
              {p.asking_price && <Datum label="Asking Price" value={formatZAR(p.asking_price)} source={src("asking_price")} />}
              {p.price_per_sqm && <Datum label="Price per m²" value={formatZAR(p.price_per_sqm)} source={src("price_per_sqm")} />}
              {p.levies && <Datum label="Monthly Levies" value={formatZAR(p.levies)} source={src("levies")} />}
              {p.rates_and_taxes && <Datum label="Monthly Rates &amp; Taxes" value={formatZAR(p.rates_and_taxes)} source={src("rates_and_taxes")} />}
            </div>
            {/* Price history */}
            {p.price_history && Array.isArray(p.price_history) && p.price_history.length > 0 && (
              <div className="mt-3 border-t pt-2">
                <div className="text-[10px] text-gray-500 font-bold uppercase mb-1">Price History</div>
                <div className="space-y-1">
                  {p.price_history.map((ph: any, i: number) => (
                    <div key={i} className="flex justify-between text-xs bg-gray-50 rounded px-2 py-1">
                      <span className="text-gray-400 font-mono">{ph.date}</span>
                      <span className="font-bold">{formatZAR(ph.price)}</span>
                      <span className="text-gray-400">{ph.event === "price_change" ? "Price changed" : ph.event}</span>
                    </div>
                  ))}
                </div>
                {p.asking_price && p.price_history.length > 0 && (() => {
                  const original = p.price_history[0].price;
                  const diff = p.asking_price - original;
                  const pct = Math.round((diff / original) * 100);
                  return diff !== 0 ? (
                    <p className="text-xs text-gray-500 mt-1">
                      {diff < 0
                        ? `Price dropped ${formatZAR(Math.abs(diff))} (${Math.abs(pct)}%) from original — seller may be motivated.`
                        : `Price increased ${formatZAR(diff)} (${pct}%) since first listed.`
                      }
                    </p>
                  ) : null;
                })()}
              </div>
            )}
          </section>
        ) : null}

        {/* ── PROPERTY FEATURES (from listing) ── */}
        <section className="bg-white border rounded-lg p-4">
          <h2 className="font-bold text-sm">Property Features</h2>
          {sectionUpdated("bedrooms", "bathrooms", "floor_area_sqm", "asking_price") && <div className="text-[9px] text-gray-300">Updated: {sectionUpdated("bedrooms", "bathrooms", "floor_area_sqm", "asking_price")}</div>}
          <div className="text-[10px] text-gray-400 mb-2">From listing structured data</div>
          <div className="grid grid-cols-3 gap-x-6">
            {p.bedrooms != null && <Datum label="Bedrooms" value={p.bedrooms} source={src("bedrooms")} />}
            {p.bathrooms != null && <Datum label="Bathrooms" value={p.bathrooms} source={src("bathrooms")} />}
            {p.parking_spaces != null && <Datum label="Parking" value={p.parking_spaces} source={src("parking_spaces")} />}
            {p.garages != null && <Datum label="Garages" value={p.garages} source={src("garages")} />}
            {p.floor_area_sqm != null && <Datum label="Floor Area" value={`${p.floor_area_sqm} m²`} source={src("floor_area_sqm")} />}
            {p.stand_size_sqm != null && <Datum label="Erf / Stand" value={`${p.stand_size_sqm} m²`} source={src("stand_size_sqm")} />}
            {p.floor_number != null && <Datum label="Floor" value={p.floor_number} source={src("floor_number")} />}
            {p.pet_friendly != null && <Datum label="Pets" value={p.pet_friendly ? "Yes" : "No"} source={src("pet_friendly")} />}
            {p.furnished != null && <Datum label="Furnished" value={p.furnished ? "Yes" : "No"} source={src("furnished")} />}
            {p.construction_era && <Datum label="Era" value={p.construction_era} source={src("construction_era")} />}
            {p.roof_material && <Datum label="Roof" value={p.roof_material} source={src("roof_material")} />}
            {p.roof_orientation && <Datum label="Orientation" value={p.roof_orientation} source={src("roof_orientation")} />}
          </div>
        </section>

        {/* ── EXTRACTED FEATURES (from description via Claude) ── */}
        <section className="bg-white border rounded-lg p-4">
          <div className="flex justify-between items-start mb-2">
            <div>
              <h2 className="font-bold text-sm">Extracted Features</h2>
              <div className="text-[10px] text-gray-400">
                Structured data extracted from listing description by <a href="https://console.anthropic.com" target="_blank" rel="noreferrer" className="text-blue-500">Claude</a> · estimated
              </div>
            </div>
            {p.description && <CollectBtn action="extract" label="Extract" ready={!!p.extracted_features} />}
          </div>
          {p.extracted_features ? (
            <div className="grid grid-cols-3 gap-x-6">
              {p.building_name && <Datum label="Building" value={p.building_name} source={src("building_name")} />}
              {p.unit_number && <Datum label="Unit" value={p.unit_number} source={src("unit_number")} />}
              {p.views && <Datum label="Views" value={p.views} source={src("views")} />}
              {p.flooring && <Datum label="Flooring" value={p.flooring} source={src("flooring")} />}
              {p.has_pool && <Datum label="Pool" value="Yes" source={src("has_pool")} />}
              {p.has_garden && <Datum label="Garden" value="Yes" source={src("has_garden")} />}
              {p.has_braai && <Datum label="Braai" value="Yes" source={src("has_braai")} />}
              {p.has_jacuzzi && <Datum label="Jacuzzi" value="Yes" source={src("has_jacuzzi")} />}
              {p.has_balcony && <Datum label="Balcony" value="Yes" source={src("has_balcony")} />}
              {p.has_aircon && <Datum label="Aircon" value="Yes" source={src("has_aircon")} />}
              {p.has_alarm && <Datum label="Alarm" value="Yes" source={src("has_alarm")} />}
              {p.has_electric_fence && <Datum label="Electric Fence" value="Yes" source={src("has_electric_fence")} />}
              {p.has_cctv && <Datum label="CCTV" value="Yes" source={src("has_cctv")} />}
              {p.has_borehole && <Datum label="Borehole" value="Yes" source={src("has_borehole")} />}
              {p.has_solar_geyser && <Datum label="Solar Geyser" value="Yes" source={src("has_solar_geyser")} />}
              {p.has_generator && <Datum label="Generator" value="Yes" source={src("has_generator")} />}
              {p.has_fibre && <Datum label="Fibre" value="Yes" source={src("has_fibre")} />}
              {p.storage_sqm && <Datum label="Storage" value={`${p.storage_sqm} m²`} source={src("storage_sqm")} />}
              {p.airbnb_friendly && <Datum label="Airbnb Friendly" value="Yes" source={src("airbnb_friendly")} />}
              {p.security_details && <Datum label="Security" value={p.security_details} source={src("security_details")} />}
            </div>
          ) : (
            <p className="text-sm text-gray-400">{p.description ? "Click Extract to process the listing description." : "No description available."}</p>
          )}
          {p.selling_points && Array.isArray(p.selling_points) && p.selling_points.length > 0 && (
            <div className="mt-3 pt-3 border-t">
              <div className="text-xs text-gray-400 mb-1">Key Selling Points</div>
              {p.selling_points.map((sp: string, i: number) => (
                <div key={i} className="text-sm text-gray-700 flex gap-2 items-start"><span className="text-gray-400 shrink-0">-</span>{sp}</div>
              ))}
              {src("selling_points") && (
                <div className="text-[9px] text-orange-500 mt-1">{src("selling_points").name} · {src("selling_points").confidence}</div>
              )}
            </div>
          )}
          {p.near_amenities && Array.isArray(p.near_amenities) && p.near_amenities.length > 0 && (
            <div className="mt-3 pt-3 border-t">
              <div className="text-xs text-gray-400 mb-1">Near Amenities</div>
              <div className="flex flex-wrap gap-1">
                {p.near_amenities.map((a: string, i: number) => (
                  <span key={i} className="bg-gray-100 text-gray-600 px-2 py-0.5 rounded text-xs">{a}</span>
                ))}
              </div>
            </div>
          )}
        </section>

        {/* ── AGENT / AGENCY ── */}
        {(p.agent_name || p.agency_name) ? (
          <section className="bg-white border rounded-lg p-4">
            <h2 className="font-bold text-sm">Listing Agent</h2>
            <div className="grid grid-cols-2 gap-x-6">
              {p.agent_name && <Datum label="Agent" value={p.agent_name} source={src("agent_name")} />}
              {p.agent_url && (
                <div className="py-1.5">
                  <span className="text-xs text-gray-400">Agent Profile</span>
                  <div><a href={p.agent_url} target="_blank" rel="noreferrer" className="text-sm text-blue-600 hover:underline">{p.agent_url}</a></div>
                </div>
              )}
              {p.agency_name && <Datum label="Agency" value={p.agency_name} source={src("agency_name")} />}
              {p.agency_url && (
                <div className="py-1.5">
                  <span className="text-xs text-gray-400">Agency Page</span>
                  <div><a href={p.agency_url} target="_blank" rel="noreferrer" className="text-sm text-blue-600 hover:underline">{p.agency_url}</a></div>
                </div>
              )}
            </div>
          </section>
        ) : null}

        {/* ── P24 COORDINATES (separate from Google geocoding) ── */}
        {p.p24_lat && (
          <section className="bg-white border rounded-lg p-4">
            <h2 className="font-bold text-sm">Property24 Coordinates</h2>
            <div className="text-[10px] text-gray-400 mb-2">From Property24 listing metadata — may differ from Google geocoding</div>
            <div className="grid grid-cols-2 gap-x-6">
              <Datum label="P24 Latitude" value={Number(p.p24_lat).toFixed(6)} source={src("p24_lat")} />
              <Datum label="P24 Longitude" value={Number(p.p24_lng).toFixed(6)} source={src("p24_lng")} />
            </div>
          </section>
        )}

        {/* ── RED FLAGS ── */}
        {(() => {
          const redFlags: A[] = [];
          // From vision findings
          for (const f of findings) {
            if (f.severity === "CRITICAL" || f.severity === "HIGH") {
              redFlags.push({ issue: f.observation || f.finding, severity: f.severity, source: "Claude Vision", cost: f.estimated_repair_cost_zar });
            }
          }
          // Asbestos — only flag if we have evidence (known construction era or vision detected indicators)
          if (r?.asbestos_risk === "CRITICAL" || r?.asbestos_risk === "HIGH") {
            // Check if any photo actually detected asbestos indicators
            const hasVisualEvidence = images?.some((i: A) => i.vision_analysis?.asbestos_indicators === true);
            const hasAgeEvidence = !!p.construction_era;
            if (hasVisualEvidence || hasAgeEvidence) {
              const source = hasVisualEvidence ? "Vision analysis detected indicators" : `Building era: ${p.construction_era}`;
              redFlags.push({ issue: `Asbestos risk: ${r.asbestos_risk}`, severity: r.asbestos_risk, source });
            }
          }
          // Crime — only flag if we have actual data AND suburb ranks in top 3
          if (crime && crime.total > 0 && crime.suburb_rank > 0 && crime.suburb_rank <= 3) {
            redFlags.push({ issue: `High crime suburb (ranked ${crime.suburb_rank}/${crime.suburbs_in_city} in ${p.city})`, severity: "HIGH", source: "SAPS" });
          }
          // Compliance issues — only if they have actual observations
          for (const f of (r?.compliance_flags || [])) {
            if (f.observation && f.observation !== "N/A") {
              redFlags.push({ issue: f.observation, severity: f.severity || "MEDIUM", source: "Claude Vision" });
            }
          }
          // Dolomite
          if (p.dolomite_risk === "CRITICAL" || p.dolomite_risk === "HIGH") {
            redFlags.push({ issue: `Dolomite/sinkhole risk: ${p.dolomite_risk}`, severity: p.dolomite_risk, source: "Council for Geoscience" });
          }
          // Flood
          if (p.flood_zone) {
            redFlags.push({ issue: `Property in flood zone (${p.flood_zone_type})`, severity: "HIGH", source: "Municipal GIS" });
          }
          // Poor sewerage
          if (p.sewerage_quality_score && p.sewerage_quality_score <= 3) {
            redFlags.push({ issue: `Critical sewerage infrastructure (${p.sewerage_quality_score}/10)`, severity: "HIGH", source: "DWS Green Drop" });
          }

          return redFlags.length > 0 ? (
            <section className="bg-red-50 border border-red-200 rounded-lg p-4">
              <h2 className="font-bold text-sm text-red-800 mb-2">Red Flags ({redFlags.length})</h2>
              <div className="space-y-1.5">
                {redFlags.map((f, i) => (
                  <div key={i} className="flex gap-2 items-start text-sm">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold shrink-0 ${severityColor[f.severity] || "bg-red-200"}`}>{f.severity}</span>
                    <div className="flex-1">
                      <span>{f.issue}</span>
                      {f.cost && <span className="text-xs text-gray-500 ml-1">({formatZAR(f.cost.min)}–{formatZAR(f.cost.max)})</span>}
                    </div>
                    <span className="text-[9px] text-gray-400 shrink-0">{f.source}</span>
                  </div>
                ))}
              </div>
            </section>
          ) : null;
        })()}

        {/* ── NEGOTIATION LEVERAGE ── */}
        {(() => {
          const leverage: { point: string; saving: string | null; source: string }[] = [];
          // Repair costs = negotiation ammo
          if (r?.repair_estimates?.total_max_zar > 0) {
            leverage.push({ point: `Total repairs estimated at ${formatZAR(r.repair_estimates.total_min_zar)}–${formatZAR(r.repair_estimates.total_max_zar)}`, saving: formatZAR(r.repair_estimates.total_max_zar), source: "Vision analysis" });
          }
          // Days on market
          if (p.listing_date) {
            const days = Math.floor((Date.now() - new Date(p.listing_date).getTime()) / 86400000);
            if (days > 30) leverage.push({ point: `Listed for ${days} days (market average ~45 days)`, saving: null, source: "PrivateProperty" });
            if (days > 90) leverage.push({ point: `On market for ${days} days — seller likely motivated`, saving: null, source: "PrivateProperty" });
          }
          // Price has been reduced
          if (p.price_history && Array.isArray(p.price_history) && p.price_history.length > 0) {
            const original = p.price_history[0].price;
            if (p.asking_price && p.asking_price < original) {
              const drop = original - p.asking_price;
              leverage.push({ point: `Price already dropped ${formatZAR(drop)} (was ${formatZAR(original)}) — seller is negotiating with themselves`, saving: formatZAR(drop), source: "Price history" });
            }
          }
          // Listing status
          if (p.listing_status === "price_reduced") leverage.push({ point: "Price has been reduced — seller is motivated to move", saving: null, source: "PrivateProperty" });
          // Levies/rates are high
          if (p.levies && p.levies > 3000) leverage.push({ point: `High monthly levies: ${formatZAR(p.levies)}`, saving: null, source: "Property24" });
          // Crime area
          if (crime && crime.total > crime.avg_across_city) {
            leverage.push({ point: `Above-average crime in ${p.suburb}`, saving: null, source: "SAPS" });
          }
          // Compliance issues
          for (const f of (r?.compliance_flags || [])) {
            leverage.push({ point: f.observation, saving: null, source: "Vision" });
          }
          // Water/sewerage issues
          if (p.sewerage_quality_score && p.sewerage_quality_score <= 4) {
            leverage.push({ point: `Poor sewerage quality in ${p.city} (${p.sewerage_quality_score}/10) — risk of backflows and infrastructure failures`, saving: null, source: "DWS Green Drop" });
          }
          // Dolomite risk
          if (p.dolomite_risk === "HIGH" || p.dolomite_risk === "CRITICAL") {
            leverage.push({ point: `Property in ${p.dolomite_risk} dolomite/sinkhole risk zone`, saving: null, source: "CGS" });
          }
          // Flood zone
          if (p.flood_zone) {
            leverage.push({ point: `Property in flood zone (${p.flood_zone_type}) — insurance implications`, saving: null, source: "Municipal GIS" });
          }
          // Heritage
          if (p.heritage_site) {
            leverage.push({ point: "Heritage area — renovation restrictions apply", saving: null, source: "SAHRIS" });
          }
          // CoC costs
          const cocsNeeded = [p.electrical_coc_required && "electrical", p.plumbing_coc_required && "plumbing", p.beetle_cert_required && "beetle"].filter(Boolean);
          if (cocsNeeded.length > 0) {
            leverage.push({ point: `Compliance certificates needed for transfer: ${cocsNeeded.join(", ")} (seller's cost)`, saving: null, source: "SA Building Regs" });
          }
          // Municipal valuation vs asking price
          if (p.municipal_valuation && p.asking_price && p.asking_price > p.municipal_valuation * 1.3) {
            leverage.push({ point: `Asking price ${Math.round(((p.asking_price / p.municipal_valuation) - 1) * 100)}% above municipal valuation (${formatZAR(p.municipal_valuation)})`, saving: formatZAR(p.asking_price - p.municipal_valuation), source: "Municipal valuation" });
          }

          return leverage.length > 0 ? (
            <section className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
              <h2 className="font-bold text-sm text-yellow-800 mb-2">Negotiation Leverage ({leverage.length} points)</h2>
              <div className="space-y-1.5">
                {leverage.map((l, i) => (
                  <div key={i} className="flex justify-between items-start text-sm">
                    <div className="flex-1">
                      <span>{l.point}</span>
                      <span className="text-[9px] text-gray-400 ml-2">{l.source}</span>
                    </div>
                    {l.saving && <span className="text-red-600 font-bold text-xs shrink-0">-{l.saving}</span>}
                  </div>
                ))}
              </div>
            </section>
          ) : null;
        })()}

        {/* ── PROPERTY INTELLIGENCE SUMMARY ── */}
        {(() => {
          // Build ADDITIVE intelligence — cross-reference data to produce
          // insights that aren't obvious from reading individual sections
          const points: string[] = [];
          const crimeDetailed = data.area_risks?.find((r: A) => r.risk_type === "crime_detailed");
          const cd = crimeDetailed?.details ? (typeof crimeDetailed.details === "string" ? JSON.parse(crimeDetailed.details) : crimeDetailed.details) : null;
          const socialData = data.area_risks?.find((r: A) => r.risk_type === "social_concerns");
          const sd = socialData?.details ? (typeof socialData.details === "string" ? JSON.parse(socialData.details) : socialData.details) : null;
          const criticalFindings = findings.filter((f: A) => f.severity === "CRITICAL" || f.severity === "HIGH");
          const hasSeriousDefects = criticalFindings.length > 0;
          const crimeWorsening = cd?.trend_5yr && cd.trend_5yr[cd.trend_5yr.length - 1] > cd.trend_5yr[0];
          const crimeHigh = cd?.total_latest > 5000;
          const hasFlood = !!p.flood_zone;
          const hasDolomite = p.dolomite_risk === "HIGH" || p.dolomite_risk === "CRITICAL";
          const poorSewerage = p.sewerage_quality_score != null && p.sewerage_quality_score <= 4;
          const pricePerSqm = p.floor_area_sqm && p.asking_price ? Math.round(p.asking_price / p.floor_area_sqm) : null;
          const overvalued = p.municipal_valuation && p.asking_price > p.municipal_valuation * 1.2;
          const daysOnMarket = p.listing_date ? Math.round((Date.now() - new Date(p.listing_date).getTime()) / 86400000) : null;

          // 1. NEGOTIATION POWER ASSESSMENT — combine all leverage signals
          const leverageSignals: string[] = [];
          if (overvalued) leverageSignals.push(`${Math.round(((p.asking_price / p.municipal_valuation) - 1) * 100)}% above municipal valuation`);
          if (daysOnMarket && daysOnMarket > 90) leverageSignals.push(`listed for ${daysOnMarket} days without selling`);
          if (hasSeriousDefects) leverageSignals.push(`${criticalFindings.length} serious defect${criticalFindings.length > 1 ? 's' : ''} requiring repair`);
          if (crimeWorsening) leverageSignals.push(`rising crime in the area`);
          if (poorSewerage) leverageSignals.push(`failing municipal sewerage infrastructure`);
          if (hasFlood) leverageSignals.push(`flood zone location`);
          if (leverageSignals.length >= 2) {
            points.push(`You have strong negotiating position here. Multiple factors work in your favour: ${leverageSignals.join(', ')}. Combined, these justify requesting a ${leverageSignals.length >= 4 ? '15-25%' : leverageSignals.length >= 3 ? '10-15%' : '5-10%'} reduction from the asking price. Present these as documented facts when making your offer — sellers rarely push back against verified data.`);
          } else if (leverageSignals.length === 1) {
            points.push(`One negotiation lever: ${leverageSignals[0]}. This alone could justify a 5-8% discount, but overall this property is reasonably positioned.`);
          }

          // 2. HIDDEN COSTS — what will this property actually cost beyond the purchase price?
          const hiddenCosts: string[] = [];
          if (hasSeriousDefects) {
            const repairTypes = criticalFindings.map((f: A) => f.observation?.toLowerCase()).filter(Boolean);
            hiddenCosts.push(`immediate repairs likely needed (${repairTypes.slice(0, 2).join(', ')})`);
          }
          if (p.electrical_coc_required && !p.plumbing_coc_required) hiddenCosts.push("electrical compliance certificate (R3,000-R15,000)");
          else if (p.electrical_coc_required && p.plumbing_coc_required) hiddenCosts.push("electrical + plumbing compliance certificates (R5,000-R25,000)");
          if (p.beetle_cert_required) hiddenCosts.push("beetle/wood borer certificate (R1,500-R4,000)");
          if (hasFlood) hiddenCosts.push("higher insurance premiums due to flood zone");
          if (hasDolomite) hiddenCosts.push("specialist geotechnical survey required (R8,000-R20,000)");
          if (poorSewerage) hiddenCosts.push("water filtration system recommended due to municipal sewerage issues");
          if (hiddenCosts.length > 0) {
            points.push(`Beyond the purchase price, budget for: ${hiddenCosts.join('; ')}. These are costs the seller won't mention but are required before or shortly after transfer. Factor these into your maximum offer price.`);
          }

          // 3. RISK-REWARD PROFILE — is the area trajectory positive or negative?
          const positiveSignals: string[] = [];
          const negativeSignals: string[] = [];
          if (cd?.trend_5yr && cd.trend_5yr[cd.trend_5yr.length - 1] < cd.trend_5yr[0]) positiveSignals.push("crime is decreasing");
          if (cd?.trend_5yr && cd.trend_5yr[cd.trend_5yr.length - 1] > cd.trend_5yr[0] * 1.1) negativeSignals.push("crime is increasing");
          if (p.solar_ghi_kwh_year && Number(p.solar_ghi_kwh_year) >= 1700) positiveSignals.push("excellent solar potential reduces electricity costs");
          if (sd?.positives?.length > sd?.concerns?.length) positiveSignals.push("area sentiment is predominantly positive");
          if (sd?.concerns?.length > 3) negativeSignals.push("multiple noise/safety concerns flagged by local reviews");
          if (poorSewerage) negativeSignals.push("municipal infrastructure declining");
          if (p.water_quality_score != null && p.water_quality_score >= 8) positiveSignals.push("strong water quality");

          if (positiveSignals.length > 0 && negativeSignals.length === 0) {
            points.push(`Area trajectory is positive: ${positiveSignals.join(', ')}. This property is in an improving environment, which typically means capital growth over 3-5 years. Good for long-term investment.`);
          } else if (negativeSignals.length > positiveSignals.length) {
            points.push(`Warning signals outweigh positives for this area: ${negativeSignals.join(', ')}. ${positiveSignals.length > 0 ? `On the upside: ${positiveSignals.join(', ')}.` : ''} If buying here, ensure the price compensates for area risk — you should be getting a discount relative to neighbouring suburbs.`);
          } else if (negativeSignals.length > 0 && positiveSignals.length > 0) {
            points.push(`Mixed signals for this area — ${positiveSignals.join(', ')}, but offset by ${negativeSignals.join(', ')}. This suggests an area in transition. If you're buying to live (not invest), these trade-offs may be acceptable at the right price.`);
          }

          // 4. INSURANCE & FINANCE IMPLICATIONS
          const insuranceFlags: string[] = [];
          if (crimeHigh) insuranceFlags.push(`high crime area (${cd.total_latest?.toLocaleString()} incidents/year) — expect higher premiums`);
          if (hasFlood) insuranceFlags.push("flood zone — some insurers may exclude water damage or charge 30-50% more");
          if (hasDolomite) insuranceFlags.push("dolomite risk — specialist cover may be required for subsidence");
          if (hasSeriousDefects) insuranceFlags.push("pre-existing defects may not be covered until repaired");
          if (insuranceFlags.length > 0) {
            points.push(`Insurance note: ${insuranceFlags.join('. ')}. Get quotes from at least 3 insurers before committing — premiums for this specific property could vary significantly. Ask your bond originator to factor insurance costs into affordability calculations.`);
          }

          // 5. WHAT TO CHECK ON-SITE — specific to THIS property's risk profile
          const checksNeeded: string[] = [];
          if (hasSeriousDefects) checksNeeded.push("get a professional building inspection focusing on the defects identified in photos");
          if (hasDolomite) checksNeeded.push("look for cracks in walls, doors that don't close properly, and uneven floors (ground movement indicators)");
          if (hasFlood) checksNeeded.push("check the ground floor and basement for water marks, damp, and mould");
          if (poorSewerage) checksNeeded.push("run all taps and flush toilets simultaneously — check for sewage smells or slow drainage");
          if (crimeHigh) checksNeeded.push("visit the neighbourhood after dark to assess how it feels at night — check for security measures on neighbouring properties");
          if (p.solar_ghi_kwh_year && Number(p.solar_ghi_kwh_year) >= 1600) checksNeeded.push("check roof orientation and shade from nearby buildings — north-facing unshaded roof is ideal for solar");
          if (checksNeeded.length > 0) {
            points.push(`When you visit this property, specifically check: ${checksNeeded.join('. ')}. These are targeted to the risks identified in the data — a generic viewing won't catch them.`);
          }

          if (points.length < 1) return null;

          return (
            <section className="bg-blue-50 border border-blue-200 rounded-lg p-4">
              <div className="flex items-center gap-2 mb-2">
                <h2 className="font-bold text-sm text-blue-900">Buyer Intelligence — What the Data Means for You</h2>
                <FeedbackBtn propertyId={p.id} section="intelligence_summary" />
              </div>
              <div className="text-sm text-blue-900 space-y-3 leading-relaxed">
                {points.map((point, i) => (
                  <p key={i} className="pl-3 border-l-2 border-blue-300">{point}</p>
                ))}
              </div>
              <div className="text-[9px] text-blue-400 mt-3">Cross-referenced from CrimeHub, PVGIS, Google Places, vision analysis, and listing data. Not financial advice — verify all findings on-site.</div>
            </section>
          );
        })()}

        {/* ── DATA SUMMARY FOOTER ── */}
        {/* Disclaimer */}
        <div className="text-[9px] text-gray-400 text-center mt-6 pt-3 border-t">
          All findings are risk indicators from data sources listed above. This report does not replace a professional building inspection or valuation. Verify all findings on-site with qualified professionals.
        </div>

        {/* Print footer */}
        <div className="print-header" style={{ textAlign: "center", marginTop: 30, fontSize: 9, color: "#888" }}>
          surepath.co.za | Confidential property report | All findings require on-site verification by qualified professionals
        </div>
      </div>
    </div>
  );
}
