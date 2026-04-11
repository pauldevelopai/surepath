"use client";
import { useState, useEffect } from "react";
import { formatZAR } from "@/lib/format";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type A = Record<string, any>;

const PILLARS = ["warning", "comparison", "reality_check", "inspection_reveal", "market_signal"];

export default function ContentPage() {
  const [pillar, setPillar] = useState(PILLARS[0]);
  const [topic, setTopic] = useState("");
  const [currentStep, setCurrentStep] = useState(0);
  const [loading, setLoading] = useState(false);
  const [postId, setPostId] = useState<number | null>(null);
  const [script, setScript] = useState({ hook: "", script: "", cta: "" });
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [captionsReady, setCaptionsReady] = useState(false);
  const [finalUrl, setFinalUrl] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  // Tease insights from WhatsApp conversations
  const [insights, setInsights] = useState<A[]>([]);
  const [selectedInsight, setSelectedInsight] = useState<A | null>(null);

  useEffect(() => {
    fetch("/api/content?action=insights").then(r => r.json()).then(data => {
      if (Array.isArray(data.insights)) setInsights(data.insights);
    });
  }, []);

  async function callApi(action: string, extra: Record<string, unknown> = {}) {
    setLoading(true);
    setMsg("");
    setError("");
    const res = await fetch("/api/content", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, pillar, topic, post_id: postId, insight: selectedInsight, ...extra }),
    });
    const json = await res.json();
    setLoading(false);
    if (json.error) setError(json.error);
    return json;
  }

  async function generateScript() {
    const json = await callApi("generate_script", {
      insight: selectedInsight || undefined,
      tease_text: teaseText || undefined,
    });
    setScript({ hook: json.hook, script: json.script, cta: json.cta });
    setPostId(json.id);
    setCurrentStep(1);
  }

  // Editable tease text — loaded from insight, refined before script generation
  const [teaseText, setTeaseText] = useState("");

  async function generateFromInsight(insight: A) {
    setSelectedInsight(insight);
    setTopic(`${insight.address} — ${insight.topRiskFlags?.[0]?.substring(0, 80) || insight.nicoTease?.substring(0, 80) || "property risk"}`);
    setPillar("inspection_reveal");
    // Pre-fill tease text for editing
    const tease = insight.nicoTease || insight.topRiskFlags?.[0] || "";
    setTeaseText(tease);
  }

  async function saveScript() {
    await callApi("update_script", { script: script.script });
    setMsg("Script saved");
  }

  async function generateAudio() {
    const json = await callApi("generate_audio");
    if (json.audio_url) {
      setAudioUrl(json.audio_url);
      setMsg(json.message || "Audio generated");
      setCurrentStep(2);
    }
  }

  async function generateCaptions() {
    const json = await callApi("generate_captions");
    if (!json.error) {
      setCaptionsReady(true);
      setMsg(json.message || "Captions generated");
      setCurrentStep(3);
    }
  }

  async function composeFinal() {
    const json = await callApi("compose_final");
    if (json.final_url) {
      setFinalUrl(json.final_url);
      setMsg(json.message || "Video composed");
      setCurrentStep(4);
    }
  }

  async function publish() {
    const json = await callApi("publish");
    if (!json.error) {
      setMsg(json.message || "Published");
      setCurrentStep(5);
    }
  }

  const stepClass = (step: number) =>
    currentStep >= step ? "opacity-100" : "opacity-40 pointer-events-none";

  return (
    <div className="max-w-4xl">
      <h1 className="text-2xl font-bold mb-1">Create Video</h1>
      <p className="text-sm text-gray-500 mb-4">Turn property insights into 10-second Nico reels</p>

      {/* Tease Insights from WhatsApp */}
      {insights.length > 0 && (
        <div className="bg-white border rounded-lg p-4 mb-6">
          <h2 className="font-bold text-sm mb-2">Nico's Best Findings</h2>
          <p className="text-xs text-gray-500 mb-3">Real property findings from WhatsApp teases, vision analysis, and Nico's evidence. Click one to turn it into a video script.</p>
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {insights.map((ins, i) => (
              <div key={i}
                className={`border rounded p-3 cursor-pointer transition ${selectedInsight?.address === ins.address ? "border-[#E63946] bg-red-50" : "hover:bg-gray-50"}`}
                onClick={() => generateFromInsight(ins)}>
                <div className="flex justify-between items-start">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">{ins.address}</span>
                      <span className={`px-1 py-0.5 rounded text-[7px] font-bold ${ins.source === "whatsapp" ? "bg-green-100 text-green-700" : ins.source === "nico_evidence" ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-600"}`}>{ins.source === "whatsapp" ? "WhatsApp" : ins.source === "nico_evidence" ? "Nico" : "Vision"}</span>
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5">{(ins.nicoTease || ins.topRiskFlags?.[0] || "").substring(0, 150)}</div>
                  </div>
                  <div className="text-right shrink-0 ml-3">
                    {ins.askingPrice && <div className="font-bold text-sm">{formatZAR(ins.askingPrice)}</div>}
                    <div className="text-[10px] text-gray-400">{ins.topRiskFlags?.length || 0} risk flags</div>
                  </div>
                </div>
                {ins.topRiskFlags?.length > 0 && (
                  <div className="flex gap-1 mt-1.5 flex-wrap">
                    {ins.topRiskFlags.slice(0, 2).map((f: string, j: number) => (
                      <span key={j} className="bg-orange-100 text-orange-700 px-2 py-0.5 rounded text-[10px]">{f.split(".")[0].substring(0, 60)}</span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Script generation */}
      <div className="space-y-3 mb-8">
        <div className="flex gap-3">
          <select className="border rounded px-3 py-2 text-sm" value={pillar} onChange={e => setPillar(e.target.value)}>
            {PILLARS.map(p => (
              <option key={p} value={p}>{p.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())}</option>
            ))}
          </select>
          <input className="flex-1 border rounded px-3 py-2 text-sm" placeholder="Topic — or click an insight above to pre-fill" value={topic} onChange={e => setTopic(e.target.value)} />
        </div>
        {selectedInsight && (
          <div className="bg-blue-50 border border-blue-200 rounded p-3 text-xs text-blue-800">
            <div className="flex justify-between items-center mb-2">
              <span>Using insight from: <strong>{selectedInsight.address}</strong> — {selectedInsight.topRiskFlags?.length || 0} risk flags</span>
              <button onClick={() => { setSelectedInsight(null); setTopic(""); setTeaseText(""); }} className="text-blue-500 hover:text-blue-700 text-xs ml-2">Clear</button>
            </div>
            <label className="text-[10px] text-blue-500 block mb-1">Refine the hook — this becomes the video's opening line</label>
            <textarea
              className="w-full border border-blue-200 rounded px-3 py-2 text-sm bg-white text-gray-900 h-20"
              value={teaseText}
              onChange={e => setTeaseText(e.target.value)}
              placeholder="Edit the tease to sharpen the hook..."
            />
          </div>
        )}
        <button onClick={generateScript} disabled={loading || !topic} className="bg-[#E63946] text-white px-6 py-2 rounded font-semibold hover:bg-red-700 disabled:opacity-50">
          {loading && currentStep === 0 ? "Generating..." : "Generate 10s Script"}
        </button>
      </div>

      {/* Step 1: Edit script */}
      <div className={stepClass(1)}>
        <h2 className="font-bold text-lg mb-2">Script</h2>
        <div className="mb-2">
          <label className="text-xs text-gray-500 block">Hook (first 3 seconds)</label>
          <input className="w-full border rounded px-3 py-2 text-sm font-bold" value={script.hook} onChange={e => setScript({ ...script, hook: e.target.value })} />
        </div>
        <div className="mb-2">
          <label className="text-xs text-gray-500 block">Script (25-35 words, ~10 seconds)</label>
          <textarea className="w-full border rounded px-3 py-2 text-sm h-24" value={script.script} onChange={e => setScript({ ...script, script: e.target.value })} />
        </div>
        <div className="mb-3">
          <label className="text-xs text-gray-500 block">CTA</label>
          <input className="w-full border rounded px-3 py-2 text-sm" value={script.cta} onChange={e => setScript({ ...script, cta: e.target.value })} />
        </div>
        <div className="flex gap-2">
          <button onClick={saveScript} disabled={loading} className="bg-gray-800 text-white px-4 py-2 rounded text-sm">Save Script</button>
          <button onClick={generateAudio} disabled={loading} className="bg-[#0D1B2A] text-white px-4 py-2 rounded text-sm">Generate Audio</button>
        </div>
      </div>

      {/* Step 2: Audio preview + generate captions */}
      <div className={`mt-6 ${stepClass(2)}`}>
        <h2 className="font-bold text-lg mb-2">Audio</h2>
        {audioUrl ? (
          <audio controls src={audioUrl} className="w-full" />
        ) : (
          <p className="text-sm text-gray-400">ElevenLabs audio will appear here</p>
        )}
        <button onClick={generateCaptions} disabled={loading} className="mt-2 bg-[#0D1B2A] text-white px-4 py-2 rounded text-sm">
          {loading && currentStep === 2 ? "Transcribing..." : "Generate Captions"}
        </button>
      </div>

      {/* Step 3: Captions ready → compose video */}
      <div className={`mt-6 ${stepClass(3)}`}>
        <h2 className="font-bold text-lg mb-2">Compose Video</h2>
        <p className="text-sm text-gray-500 mb-2">
          {selectedInsight?.propertyId
            ? "Property photos will be used as slideshow background with branded caption bar."
            : "Branded Surepath background with caption overlay."}
        </p>
        {captionsReady && <p className="text-xs text-green-600 mb-2">Captions ready</p>}
        <button onClick={composeFinal} disabled={loading} className="bg-[#0D1B2A] text-white px-4 py-2 rounded text-sm">
          {loading && currentStep === 3 ? "Composing..." : "Compose Final Video"}
        </button>
      </div>

      {/* Step 4: Final video preview + publish */}
      <div className={`mt-6 ${stepClass(4)}`}>
        <h2 className="font-bold text-lg mb-2">Final Video</h2>
        {finalUrl ? (
          <video controls src={finalUrl} className="w-full rounded max-w-sm" />
        ) : (
          <p className="text-sm text-gray-400">Composed video will appear here</p>
        )}
        <button onClick={publish} disabled={loading} className="mt-2 bg-[#E63946] text-white px-6 py-2 rounded font-semibold">Publish to All Platforms</button>
      </div>

      {/* Step 5: Published */}
      {currentStep >= 5 && (
        <div className="mt-6 bg-green-50 p-4 rounded text-green-800 text-sm">
          Published to Instagram, TikTok, and YouTube.
        </div>
      )}

      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
      {msg && !error && <p className="mt-4 text-sm text-blue-600">{msg}</p>}
    </div>
  );
}
