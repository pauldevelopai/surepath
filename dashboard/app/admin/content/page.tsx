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
  const [script, setScript] = useState("");
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [captionsReady, setCaptionsReady] = useState(false);
  const [finalUrl, setFinalUrl] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  // Tease insights from WhatsApp conversations
  const [insights, setInsights] = useState<A[]>([]);
  const [selectedInsight, setSelectedInsight] = useState<A | null>(null);

  // TikTok connection state
  const [tiktok, setTiktok] = useState<{ connected: boolean; configured: boolean; account?: A } | null>(null);

  useEffect(() => {
    fetch("/api/content?action=insights").then(r => r.json()).then(data => {
      if (Array.isArray(data.insights)) setInsights(data.insights);
    });
    fetch("/api/tiktok/status").then(r => r.json()).then(setTiktok);

    // Check URL for TikTok callback outcome
    const params = new URLSearchParams(window.location.search);
    if (params.get("tiktok_connected")) setMsg("TikTok connected");
    if (params.get("tiktok_error")) setError(`TikTok: ${params.get("tiktok_error")}`);

    // If ?id= is set, load an existing video
    const loadId = params.get("id");
    if (loadId) {
      fetch("/api/content?action=list").then(r => r.json()).then(data => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const video = (data.videos || []).find((v: any) => String(v.id) === loadId);
        if (video) {
          setPostId(video.id);
          setScript(video.script || "");
          setPillar(video.pillar || PILLARS[0]);
          setTopic(video.script?.substring(0, 60) || "Loaded draft");
          if (video.audio_url) setAudioUrl(video.audio_url);
          if (video.srt_content) setCaptionsReady(true);
          if (video.final_video_url) setFinalUrl(video.final_video_url);
          // Walk the pipeline step forward to the last completed stage
          if (video.final_video_url) setCurrentStep(4);
          else if (video.srt_content) setCurrentStep(3);
          else if (video.audio_url) setCurrentStep(2);
          else if (video.script) setCurrentStep(1);
        }
      });
    }
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
    setScript(json.script || "");
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
    await callApi("update_script", { script });
    setMsg("Script saved");
  }

  const wordCount = script.trim() ? script.trim().split(/\s+/).length : 0;
  const wordCountColour = wordCount === 0
    ? "text-gray-400"
    : wordCount <= 28
      ? "text-green-600"
      : wordCount <= 35
        ? "text-amber-600"
        : "text-red-600";

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


  const stepClass = (step: number) =>
    currentStep >= step ? "opacity-100" : "opacity-40 pointer-events-none";

  return (
    <div className="max-w-4xl">
      <h1 className="text-2xl font-bold mb-1">Create Video</h1>
      <p className="text-sm text-gray-500 mb-4">Turn property insights into 10-second Nico reels</p>

      {/* TikTok connection status */}
      {tiktok && (
        <div className={`mb-4 rounded border p-3 text-xs flex items-center justify-between ${tiktok.connected ? "border-green-300 bg-green-50" : tiktok.configured ? "border-amber-300 bg-amber-50" : "border-gray-200 bg-gray-50"}`}>
          <div>
            {tiktok.connected ? (
              <span className="text-green-700">TikTok connected{tiktok.account?.display_name ? ` · ${tiktok.account.display_name}` : ""}</span>
            ) : tiktok.configured ? (
              <span className="text-amber-700">TikTok app configured but not connected — click to authorize</span>
            ) : (
              <span className="text-gray-600">TikTok API not configured (set TIKTOK_CLIENT_KEY + TIKTOK_CLIENT_SECRET on server)</span>
            )}
          </div>
          {tiktok.configured && (
            <a href="/api/tiktok/connect" className="bg-black text-white px-3 py-1 rounded text-xs font-semibold hover:bg-gray-800">
              {tiktok.connected ? "Reconnect" : "Connect TikTok"}
            </a>
          )}
        </div>
      )}

      {/* Tease Insights from WhatsApp */}
      {insights.length > 0 && (
        <div className="bg-white border rounded-lg p-4 mb-6">
          <h2 className="font-bold text-sm mb-2">Nico's Best Findings</h2>
          <p className="text-xs text-gray-500 mb-3">Real property findings from WhatsApp teases, vision analysis, and Nico's evidence. Click one to turn it into a video script.</p>
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {insights.map((ins, i) => (
              <div key={i}
                className={`border rounded p-3 cursor-pointer transition ${selectedInsight?.address === ins.address ? "border-[#E63946] bg-red-50" : ins.videoCount > 0 ? "border-gray-200 bg-gray-50/50" : "hover:bg-gray-50"}`}
                onClick={() => generateFromInsight(ins)}>
                <div className="flex justify-between items-start">
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`font-medium text-sm ${ins.videoCount > 0 ? "text-gray-500" : ""}`}>{ins.address}</span>
                      <span className={`px-1 py-0.5 rounded text-[7px] font-bold ${ins.source === "whatsapp" ? "bg-green-100 text-green-700" : ins.source === "nico_evidence" ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-600"}`}>{ins.source === "whatsapp" ? "WhatsApp" : ins.source === "nico_evidence" ? "Nico" : "Vision"}</span>
                      {ins.videoCount > 0 && (
                        <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${ins.anyPosted ? "bg-green-600 text-white" : "bg-blue-600 text-white"}`}>
                          {ins.anyPosted ? `Posted · ${ins.videoCount} video${ins.videoCount > 1 ? "s" : ""}` : `${ins.videoCount} video${ins.videoCount > 1 ? "s" : ""} made`}
                        </span>
                      )}
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
        <div className="mb-3 relative">
          <label className="text-xs text-gray-500 block mb-1">Full script — hook, punch, CTA flow as one (~22-28 words for 10 seconds)</label>
          <textarea
            className="w-full border rounded px-3 py-2 text-sm h-32 font-medium"
            value={script}
            onChange={e => setScript(e.target.value)}
          />
          <div className={`absolute bottom-2 right-3 text-xs font-bold ${wordCountColour} bg-white/90 px-2 py-0.5 rounded`}>
            {wordCount} words
          </div>
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

      {/* Step 3: Generate the visual video (photos slideshow + captions + audio + WhatsApp banner) */}
      <div className={`mt-6 ${stepClass(3)}`}>
        <h2 className="font-bold text-lg mb-2">Video</h2>
        <p className="text-sm text-gray-500 mb-2">
          {selectedInsight?.propertyId
            ? "Property photos will be matched to each beat of the script, with stock footage for abstract moments. Branded caption bar + WhatsApp end-banner added automatically."
            : "Branded Surepath background with captions + WhatsApp end-banner."}
        </p>
        {captionsReady && <p className="text-xs text-green-600 mb-2">Captions ready</p>}
        <button onClick={composeFinal} disabled={loading} className="bg-[#0D1B2A] text-white px-4 py-2 rounded text-sm">
          {loading && currentStep === 3 ? "Generating video... (~60s)" : "Generate Video"}
        </button>
      </div>

      {/* Step 4: Preview the finished video — stored, not auto-published */}
      <div className={`mt-6 ${stepClass(4)}`}>
        <h2 className="font-bold text-lg mb-2">Preview</h2>
        {finalUrl ? (
          <>
            <video controls src={finalUrl} className="w-full rounded max-w-sm" />
            <div className="mt-3 bg-green-50 border border-green-200 rounded p-3 text-sm text-green-800">
              Video saved to your library. Review and publish from the <a href="/admin/videos" className="font-bold underline">Videos page</a> when you&apos;re ready.
            </div>
          </>
        ) : (
          <p className="text-sm text-gray-400">Composed video will appear here</p>
        )}
      </div>

      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
      {msg && !error && <p className="mt-4 text-sm text-blue-600">{msg}</p>}
    </div>
  );
}
