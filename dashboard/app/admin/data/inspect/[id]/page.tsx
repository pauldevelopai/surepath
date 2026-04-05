"use client";
import { useEffect, useState, useRef, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { formatZAR, formatDate, severityColor } from "@/lib/format";
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

  const { property: p, sources, unverified_fields: unverified, report: r, images, deeds: d, crime, pdf_exports: pdfExports } = data;

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
    ];

    const results: string[] = [];

    for (const step of steps) {
      setRunAllStep(step.label);
      try {
        const res = await fetch(`/api/collect/${id}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: step.action }),
        });
        const json = await res.json();
        if (json.ok) {
          results.push(`${step.label}: ${json.message}`);
        } else {
          results.push(`${step.label}: skipped — ${json.message}`);
        }
      } catch (err) {
        results.push(`${step.label}: error`);
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
        <div className="flex gap-4 mt-2 text-xs">
          {p.listing_date && (
            <div className="bg-blue-50 border border-blue-200 rounded px-2 py-1">
              <span className="text-blue-500">Listed:</span> <span className="font-medium">{formatDate(p.listing_date)}</span>
              <span className="text-blue-400 ml-1">(from listing)</span>
            </div>
          )}
          <div className="bg-gray-50 border border-gray-200 rounded px-2 py-1">
            <span className="text-gray-500">First captured:</span> <span className="font-medium">{formatDate(p.created_at)}</span>
          </div>
          {p.last_scraped_at && (
            <div className="bg-gray-50 border border-gray-200 rounded px-2 py-1">
              <span className="text-gray-500">Last scraped:</span> <span className="font-medium">{formatDate(p.last_scraped_at)}</span>
            </div>
          )}
        </div>
      </div>

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

        {/* ── STREET VIEW ── */}
        <section className="bg-white border rounded-lg p-4">
          <div className="flex justify-between items-start mb-2">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="font-bold text-sm">Street View</h2>
                <FeedbackBtn propertyId={p.id} section="streetview" />
              </div>
              <div className="text-[10px] text-gray-400"><a href="https://developers.google.com/maps/documentation/streetview" target="_blank" rel="noreferrer" className="text-blue-500 hover:underline">Google Street View Static API</a> &middot; $7/1k</div>
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
                  <span className="flex-1">{f.observation}</span>
                  <span className="text-[9px] text-orange-500">Claude Vision</span>
                </div>
              ))}
            </div>
          ) : <p className="text-sm text-gray-400">{hasCoords ? "Not captured." : "Geocode first."}</p>}
        </section>

        {/* ── SATELLITE ── */}
        <section className="bg-white border rounded-lg p-4">
          <div className="flex justify-between items-start mb-2">
            <div>
              <h2 className="font-bold text-sm">Satellite / Aerial</h2>
              <div className="text-[10px] text-gray-400"><a href="https://developers.google.com/maps/documentation/maps-static" target="_blank" rel="noreferrer" className="text-blue-500 hover:underline">Google Maps Static API</a> &middot; $2/1k</div>
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
              {satelliteImg.vision_analysis && (
                <div className="mt-1">
                  <Datum label="Roof Material" value={satelliteImg.vision_analysis.roof_material} source={{ name: "Claude Vision", url: "https://console.anthropic.com", confidence: "estimated" }} />
                  <Datum label="Roof Orientation" value={satelliteImg.vision_analysis.roof_orientation_estimate} source={{ name: "Claude Vision", url: "https://console.anthropic.com", confidence: "estimated" }} />
                  <Datum label="Solar Panels" value={satelliteImg.vision_analysis.solar_installed ? "Visible" : "None visible"} source={{ name: "Claude Vision", url: "https://console.anthropic.com", confidence: "estimated" }} />
                </div>
              )}
            </div>
          ) : <p className="text-sm text-gray-400">{hasCoords ? "Not captured." : "Geocode first."}</p>}
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
              <h2 className="font-bold text-sm">Vision Analysis ({findings.length} findings)</h2>
              {sectionUpdated("roof_material", "security_visible") && <span className="text-[9px] text-gray-300 ml-2">Updated: {sectionUpdated("roof_material", "security_visible")}</span>}
              <div className="text-[10px] text-gray-400"><a href="https://console.anthropic.com" target="_blank" rel="noreferrer" className="text-blue-500 hover:underline">Anthropic Claude</a> &middot; estimated &middot; ~R1.35</div>
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
                      <span>{f.observation || f.finding}</span>
                      {f.estimated_repair_cost_zar && <span className="text-gray-400 ml-1">({formatZAR(f.estimated_repair_cost_zar.min)}–{formatZAR(f.estimated_repair_cost_zar.max)})</span>}
                      {f.source_photo && <a href={f.source_photo} target="_blank" rel="noreferrer" className="text-blue-500 hover:underline ml-2">[photo]</a>}
                    </div>
                    <span className="text-[9px] text-orange-500 shrink-0">estimated</span>
                  </div>
                )))}
              </div>
            </>
          ) : <p className="text-sm text-gray-400">{(images?.length || 0) > 0 ? "Select photos above then click Analyse." : "No photos to analyse."}</p>}
        </section>

        {/* ── DEEDS ── */}
        <section className="bg-white border rounded-lg p-4">
          <h2 className="font-bold text-sm">Deeds &amp; Ownership</h2>
          {hasDeeds ? (
            <div>
              <Datum label="Registered Owner" value={d.registered_owner} source={{ name: "Windeed", url: "https://www.windeed.co.za", confidence: "verified" }} />
              <Datum label="Title Deed" value={d.title_deed_ref} source={{ name: "Windeed", url: "https://www.windeed.co.za", confidence: "verified" }} />
              <Datum label="Municipal Value" value={formatZAR(d.municipal_value)} source={{ name: "Windeed", url: "https://www.windeed.co.za", confidence: "verified" }} />
            </div>
          ) : <p className="text-sm text-gray-400">Data unavailable</p>}
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
                  const areaKeywords = new Set(['unsafe', 'crime', 'robbery', 'stolen', 'break-in', 'mugging', 'noise', 'noisy', 'loud', 'traffic', 'flood', 'flooding', 'loadshedding', 'load shedding', 'power cut', 'sewage', 'pollution', 'construction']);
                  const relevant = concerns
                    .filter((c: A) => (c.keywords || []).some((k: string) => areaKeywords.has(k)))
                    .slice(0, 5);
                  const shown = relevant.length > 0 ? relevant : concerns.slice(0, 5);
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
                    <h3 className="text-xs font-bold mb-1">Security Companies ({companies.length})</h3>
                    <div className="space-y-2">
                      {companies.map((co: A, i: number) => (
                        <div key={i} className="bg-gray-50 rounded p-2 text-xs">
                          <div className="flex justify-between items-start">
                            <div>
                              <span className="font-bold">{co.name}</span>
                              {co.armed_response && <span className="ml-1.5 bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded text-[9px] font-bold">ARMED RESPONSE</span>}
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
                        <div className="font-medium">{cpf.name}</div>
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
                        <div className="font-medium">{nhw.name}</div>
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
                <Datum label="Water Quality" value={`${p.water_quality_score}/10`} source={src("water_quality_score")} />
                <p className="text-xs text-gray-500 mt-1">{
                  p.water_quality_score >= 8 ? "Good — municipal water supply meets national standards. Safe for drinking."
                  : p.water_quality_score >= 5 ? "Moderate — water supply is functional but has some quality concerns. Consider a water filter."
                  : "Poor — water supply has serious quality issues. Install filtration. Check for pipe corrosion risk."
                }</p>
              </div>
            )}
            {p.sewerage_quality_score != null && (
              <div className={`rounded p-2 ${p.sewerage_quality_score <= 4 ? "bg-red-50" : "bg-gray-50"}`}>
                <Datum label="Sewerage Quality" value={`${p.sewerage_quality_score}/10`} source={src("sewerage_quality_score")} />
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

        {/* ── COMPLIANCE CERTIFICATES ── */}
        {p.electrical_coc_required != null && (
          <section className="bg-white border rounded-lg p-4">
            <h2 className="font-bold text-sm">Compliance Certificates Required for Transfer</h2>
            <div className="text-[10px] text-gray-400 mb-2">
              <a href="https://www.sahomeloans.com/bond-talk/guide-compliance-certificates" target="_blank" rel="noreferrer" className="text-blue-500">SA National Building Regulations</a> &middot; Required by law for property transfer
            </div>
            <div className="space-y-2">
              {[
                { label: "Electrical CoC", needed: p.electrical_coc_required, src: "OHS Act 1993", explain: "Required for every property transfer. The seller must provide a valid certificate (less than 2 years old) confirming the electrical installation is safe. Cost: R1,500-R5,000 depending on property size. If the installation fails, the seller pays for repairs." },
                { label: "Plumbing CoC", needed: p.plumbing_coc_required, src: "Cape Town by-laws", explain: "Required in Cape Town for all property transfers. Confirms plumbing meets municipal standards. Cost: R1,000-R3,000. Common failures: leaking taps, non-compliant geyser installations, incorrect pipe sizing." },
                { label: "Beetle Certificate", needed: p.beetle_cert_required, src: "WC/KZN requirement", explain: "Required in Western Cape and KZN. Confirms the property is free from wood-boring beetles. If beetles are found, treatment costs R3,000-R15,000 depending on severity. Roof timbers are the main concern." },
                { label: "Gas CoC", needed: p.gas_coc_required, src: "Pressure Equipment Regs", explain: "Required if the property has any gas installation (stove, heater, braai). Must be issued by a registered gas installer. Cost: R800-R2,000." },
                { label: "Electric Fence CoC", needed: p.electric_fence_coc_required, src: "OHS Act", explain: "Required if the property has an electric fence. Must comply with SANS 10222-3. Cost: R500-R1,500. Non-compliant fences must be upgraded at seller's expense." },
              ].filter(c => c.needed).map(c => (
                <div key={c.label} className="bg-yellow-50 border border-yellow-200 rounded p-3 text-xs">
                  <div className="font-bold text-yellow-800">{c.label} <span className="font-normal text-yellow-600">— {c.src}</span></div>
                  <p className="text-yellow-700 mt-1">{c.explain}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ── AREA RISK DATA ── */}
        {data.area_risks?.length > 0 && (
          <section className="bg-white border rounded-lg p-4">
            <h2 className="font-bold text-sm">Area Risk Intelligence</h2>
            <div className="text-[10px] text-gray-400 mb-2">Suburb and city level risk data from government sources</div>
            <div className="space-y-1">
              {data.area_risks.map((r: A, i: number) => (
                <div key={i} className="flex justify-between items-center text-sm bg-gray-50 rounded p-2">
                  <div>
                    <span className="capitalize font-medium">{r.risk_type.replace(/_/g, " ")}</span>
                    {r.risk_level && <span className={`ml-2 px-1.5 py-0.5 rounded text-[10px] font-bold ${
                      r.risk_level === "CRITICAL" || r.risk_level === "HIGH" ? "bg-red-100 text-red-700" :
                      r.risk_level === "MEDIUM" ? "bg-yellow-100 text-yellow-700" :
                      "bg-green-100 text-green-700"
                    }`}>{r.risk_level}</span>}
                    {r.risk_score != null && <span className="ml-2 text-xs text-gray-500">{r.risk_score}/10</span>}
                  </div>
                  <a href={r.source_url} target="_blank" rel="noreferrer" className="text-[9px] text-blue-500 hover:underline">{r.source_name}</a>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Service providers link */}
        {p.city && (
          <a href="/admin/services" className="block text-sm text-blue-600 hover:underline mb-2">
            View service providers in {p.city} &rarr;
          </a>
        )}

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
            {p.property_type && <Datum label="Property Type" value={p.property_type} source={src("property_type")} />}
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
            if (days > 30) leverage.push({ point: `Listed for ${days} days (market average ~45 days)`, saving: null, source: "Property24" });
            if (days > 90) leverage.push({ point: `On market for ${days} days — seller likely motivated`, saving: null, source: "Property24" });
          }
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
        <section className="bg-[#0D1B2A] text-white rounded-lg p-6">
          <div className="grid grid-cols-2 gap-4 text-sm">
            {p.solar_ghi_kwh_year && (
              <div>
                <div className="text-gray-400 text-[10px]">Solar Irradiance (PVGIS verified)</div>
                <div className="font-bold">{Number(p.solar_ghi_kwh_year).toFixed(0)} kWh/m²/year</div>
                <div className="text-[10px] text-gray-500">PV output: {Number(p.solar_pv_output_kwh_year).toFixed(0)} kWh/year per 1kWp</div>
              </div>
            )}
            {p.suburb_crime_score != null && p.suburb_crime_score > 0 && (
              <div>
                <div className="text-gray-400 text-[10px]">Crime Score (CrimeHub/SAPS verified)</div>
                <div className="font-bold">{p.suburb_crime_score}/10</div>
              </div>
            )}
          </div>
          <div className="text-[9px] text-gray-500 mt-4 pt-3 border-t border-white/10">
            All findings are risk indicators from data sources listed above. This report does not replace a professional building inspection or valuation. Verify all findings on-site with qualified professionals.
          </div>
        </section>

        {/* Print footer */}
        <div className="print-header" style={{ textAlign: "center", marginTop: 30, fontSize: 9, color: "#888" }}>
          surepath.co.za | Confidential property report | All findings require on-site verification by qualified professionals
        </div>
      </div>
    </div>
  );
}
