"use client";
import { useState } from "react";

const PILLARS = ["warning", "comparison", "reality_check", "inspection_reveal", "market_signal"];

export default function ContentPage() {
  const [pillar, setPillar] = useState(PILLARS[0]);
  const [topic, setTopic] = useState("");
  const [currentStep, setCurrentStep] = useState(0);
  const [loading, setLoading] = useState(false);
  const [postId, setPostId] = useState<number | null>(null);
  const [script, setScript] = useState({ hook: "", script: "", cta: "" });
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [finalUrl, setFinalUrl] = useState<string | null>(null);
  const [msg, setMsg] = useState("");

  async function callApi(action: string, extra: Record<string, unknown> = {}) {
    setLoading(true);
    setMsg("");
    const res = await fetch("/api/content", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, pillar, topic, post_id: postId, ...extra }),
    });
    const json = await res.json();
    setLoading(false);
    return json;
  }

  async function generateScript() {
    const json = await callApi("generate_script");
    setScript({ hook: json.hook, script: json.script, cta: json.cta });
    setPostId(json.id);
    setCurrentStep(1);
  }

  async function saveScript() {
    await callApi("update_script", { script: script.script });
    setMsg("Script saved");
  }

  async function generateAudio() {
    const json = await callApi("generate_audio");
    setAudioUrl(json.audio_url);
    setMsg(json.message || "Audio generated");
    setCurrentStep(2);
  }

  async function generateVideo() {
    const json = await callApi("generate_video");
    setVideoUrl(json.video_url);
    setMsg(json.message || "Video generated");
    setCurrentStep(3);
  }

  async function composeFinal() {
    const json = await callApi("compose_final");
    setFinalUrl(json.final_url);
    setMsg(json.message || "Final composed");
    setCurrentStep(4);
  }

  async function publish() {
    const json = await callApi("publish");
    setMsg(json.message || "Published");
    setCurrentStep(5);
  }

  const stepClass = (step: number) =>
    currentStep >= step ? "opacity-100" : "opacity-40 pointer-events-none";

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-bold mb-4">Content Generation</h1>

      {/* Step 0: Script generation */}
      <div className="space-y-3 mb-8">
        <div className="flex gap-3">
          <select className="border rounded px-3 py-2 text-sm" value={pillar} onChange={e => setPillar(e.target.value)}>
            {PILLARS.map(p => (
              <option key={p} value={p}>{p.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())}</option>
            ))}
          </select>
          <input className="flex-1 border rounded px-3 py-2 text-sm" placeholder="Topic (e.g. 'Why R500k houses in Lavender Hill are a trap')" value={topic} onChange={e => setTopic(e.target.value)} />
        </div>
        <button onClick={generateScript} disabled={loading || !topic} className="bg-[#E63946] text-white px-6 py-2 rounded font-semibold hover:bg-red-700 disabled:opacity-50">
          {loading && currentStep === 0 ? "Generating..." : "Generate Script"}
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
          <label className="text-xs text-gray-500 block">Script</label>
          <textarea className="w-full border rounded px-3 py-2 text-sm h-40" value={script.script} onChange={e => setScript({ ...script, script: e.target.value })} />
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

      {/* Step 2: Audio */}
      <div className={`mt-6 ${stepClass(2)}`}>
        <h2 className="font-bold text-lg mb-2">Audio</h2>
        {audioUrl ? (
          <audio controls src={audioUrl} className="w-full" />
        ) : (
          <p className="text-sm text-gray-400">ElevenLabs audio will appear here</p>
        )}
        <button onClick={generateVideo} disabled={loading} className="mt-2 bg-[#0D1B2A] text-white px-4 py-2 rounded text-sm">Generate Avatar Video</button>
      </div>

      {/* Step 3: Avatar video */}
      <div className={`mt-6 ${stepClass(3)}`}>
        <h2 className="font-bold text-lg mb-2">Avatar Video</h2>
        {videoUrl ? (
          <video controls src={videoUrl} className="w-full rounded" />
        ) : (
          <p className="text-sm text-gray-400">HeyGen avatar video will appear here</p>
        )}
        <button onClick={composeFinal} disabled={loading} className="mt-2 bg-[#0D1B2A] text-white px-4 py-2 rounded text-sm">Compose Final Video</button>
      </div>

      {/* Step 4: Final video */}
      <div className={`mt-6 ${stepClass(4)}`}>
        <h2 className="font-bold text-lg mb-2">Final Video</h2>
        {finalUrl ? (
          <video controls src={finalUrl} className="w-full rounded" />
        ) : (
          <p className="text-sm text-gray-400">FFmpeg composed video will appear here</p>
        )}
        <button onClick={publish} disabled={loading} className="mt-2 bg-[#E63946] text-white px-6 py-2 rounded font-semibold">Publish to All Platforms</button>
      </div>

      {/* Step 5: Published */}
      {currentStep >= 5 && (
        <div className="mt-6 bg-green-50 p-4 rounded text-green-800 text-sm">
          Published to Instagram, TikTok, and YouTube.
        </div>
      )}

      {msg && <p className="mt-4 text-sm text-blue-600">{msg}</p>}
    </div>
  );
}
