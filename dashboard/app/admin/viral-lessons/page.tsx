"use client";
import { useEffect, useState } from "react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Lesson = Record<string, any>;

export default function ViralLessonsPage() {
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  const [form, setForm] = useState({
    source_url: "",
    caption: "",
    hashtags: "",
    hook_text: "",
    view_count: "",
    like_count: "",
    comment_count: "",
    share_count: "",
    duration_sec: "",
    niche: "property",
  });
  const [isOwnContent, setIsOwnContent] = useState(false);

  async function fetchFromUrl() {
    if (!form.source_url.trim()) { setError("Paste a TikTok URL first"); return; }
    setFetching(true);
    setError("");
    setMsg("");
    try {
      const res = await fetch("/api/viral-lessons/fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: form.source_url.trim() }),
      });
      const data = await res.json();
      if (data.error) { setError(data.error); setFetching(false); return; }
      setForm({
        source_url: data.source_url || form.source_url,
        caption: data.caption || "",
        hashtags: data.hashtags || "",
        hook_text: data.hook_text || "",
        view_count: String(data.view_count || ""),
        like_count: String(data.like_count || ""),
        comment_count: String(data.comment_count || ""),
        share_count: String(data.share_count || ""),
        duration_sec: String(data.duration_sec || ""),
        niche: "property",
      });
      setMsg(`Fetched ${Number(data.view_count).toLocaleString()} views · ${Number(data.like_count).toLocaleString()} likes — click Extract Lesson to analyse`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Fetch failed");
    }
    setFetching(false);
  }

  async function fetchAndAnalyse() {
    if (!form.source_url.trim()) { setError("Paste a TikTok URL first"); return; }
    setSubmitting(true);
    setError("");
    setMsg("Fetching video data...");
    try {
      const fetchRes = await fetch("/api/viral-lessons/fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: form.source_url.trim() }),
      });
      const fetched = await fetchRes.json();
      if (fetched.error) { setError(fetched.error); setSubmitting(false); return; }

      setMsg("Analysing with Claude...");
      const analyseRes = await fetch("/api/viral-lessons", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...fetched, is_own_content: isOwnContent }),
      });
      const analysed = await analyseRes.json();
      if (analysed.error) { setError(analysed.error); setSubmitting(false); return; }

      setMsg(`Lesson added: ${analysed.one_line_lesson}${isOwnContent ? ' (your own content — weighted highly)' : ''}`);
      setForm({
        source_url: "", caption: "", hashtags: "", hook_text: "",
        view_count: "", like_count: "", comment_count: "", share_count: "",
        duration_sec: "", niche: "property",
      });
      setIsOwnContent(false);
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed");
    }
    setSubmitting(false);
  }

  async function load() {
    setLoading(true);
    const res = await fetch("/api/viral-lessons");
    const json = await res.json();
    setLessons(json.lessons || []);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function submit() {
    setSubmitting(true);
    setMsg("");
    setError("");
    const payload = {
      ...Object.fromEntries(Object.entries(form).map(([k, v]) => [k, v.trim()])),
      is_own_content: isOwnContent,
    };
    const res = await fetch("/api/viral-lessons", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    setSubmitting(false);
    if (json.error) { setError(json.error); return; }
    setMsg(`Lesson added: ${json.one_line_lesson}`);
    setForm({
      source_url: "", caption: "", hashtags: "", hook_text: "",
      view_count: "", like_count: "", comment_count: "", share_count: "",
      duration_sec: "", niche: "property",
    });
    setIsOwnContent(false);
    load();
  }

  async function toggleActive(id: number, active: boolean) {
    await fetch("/api/viral-lessons", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, active: !active }),
    });
    load();
  }

  async function deleteLesson(id: number) {
    if (!confirm("Delete this lesson?")) return;
    await fetch(`/api/viral-lessons?id=${id}`, { method: "DELETE" });
    load();
  }

  return (
    <div className="max-w-5xl">
      <h1 className="text-2xl font-bold mb-1">Viral Lessons</h1>
      <p className="text-sm text-gray-500 mb-1">
        Paste a viral TikTok URL. Claude extracts the hook style and tactical lesson.
      </p>
      <div className="text-xs text-gray-500 mb-5 space-y-1">
        <p>Every saved lesson does two things:</p>
        <ul className="list-disc ml-4">
          <li><strong>Few-shot examples:</strong> the top 6 lessons are injected into the script-generation prompt as inspiration.</li>
          <li><strong>RAG layer:</strong> the full lesson is embedded into the &ldquo;viral_lesson&rdquo; knowledge layer so it surfaces in semantic retrieval alongside defect facts.</li>
        </ul>
        <p>Mark a lesson as <em>your own content</em> and it gets a 10× score boost so it always rises to the top.</p>
      </div>

      {/* URL-first quick path */}
      <div className="bg-gradient-to-r from-red-50 to-orange-50 border border-red-200 rounded-lg p-5 mb-4">
        <h2 className="font-bold text-sm mb-1">Fast path — paste a TikTok URL</h2>
        <p className="text-xs text-gray-600 mb-3">We&apos;ll pull views, likes, comments, caption, hashtags and duration automatically, then Claude extracts the lesson.</p>
        <div className="flex gap-2">
          <input
            className="flex-1 border rounded px-3 py-2 text-sm"
            placeholder="https://www.tiktok.com/@someone/video/1234567890"
            value={form.source_url}
            onChange={e => setForm({ ...form, source_url: e.target.value })}
          />
          <button
            onClick={fetchFromUrl}
            disabled={fetching || submitting}
            className="bg-gray-800 hover:bg-gray-900 text-white px-4 py-2 rounded text-sm disabled:opacity-50 whitespace-nowrap"
          >
            {fetching ? "Fetching..." : "Fetch & Preview"}
          </button>
          <button
            onClick={fetchAndAnalyse}
            disabled={fetching || submitting}
            className="bg-[#E63946] hover:bg-red-700 text-white px-4 py-2 rounded text-sm font-semibold disabled:opacity-50 whitespace-nowrap"
          >
            {submitting ? "Working..." : "Fetch + Extract"}
          </button>
        </div>
        <label className="flex items-center gap-2 mt-3 text-sm text-gray-700 cursor-pointer">
          <input
            type="checkbox"
            checked={isOwnContent}
            onChange={e => setIsOwnContent(e.target.checked)}
            className="w-4 h-4 accent-[#E63946]"
          />
          <span>This is <strong>our own Surepath video</strong> that went viral — weight this lesson 10× higher and always include it in script generation.</span>
        </label>
        {msg && <p className="text-xs text-green-700 mt-2">{msg}</p>}
        {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
      </div>

      {/* Manual entry (still available if URL fetch fails) */}
      <div className="bg-white border rounded-lg p-5 mb-8">
        <h2 className="font-bold text-sm mb-1">Or add manually</h2>
        <p className="text-xs text-gray-500 mb-3">If the URL fetch fails (private video, broken link, etc.) you can paste the details directly.</p>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-gray-500 block mb-1">Caption (full text of the post)</label>
            <textarea className="w-full border rounded px-3 py-2 text-sm h-24" placeholder="Paste the full caption including hashtags"
              value={form.caption} onChange={e => setForm({ ...form, caption: e.target.value })} />
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">Hook (the first spoken line or on-screen text)</label>
            <input className="w-full border rounded px-3 py-2 text-sm" placeholder="e.g. This house will cost you R200k"
              value={form.hook_text} onChange={e => setForm({ ...form, hook_text: e.target.value })} />
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">Hashtags (if not already in caption)</label>
            <input className="w-full border rounded px-3 py-2 text-sm" placeholder="#property #southafrica ..."
              value={form.hashtags} onChange={e => setForm({ ...form, hashtags: e.target.value })} />
          </div>

          <div className="grid grid-cols-5 gap-3">
            <div>
              <label className="text-xs text-gray-500 block mb-1">Views</label>
              <input className="w-full border rounded px-2 py-1.5 text-sm" type="number" value={form.view_count}
                onChange={e => setForm({ ...form, view_count: e.target.value })} />
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">Likes</label>
              <input className="w-full border rounded px-2 py-1.5 text-sm" type="number" value={form.like_count}
                onChange={e => setForm({ ...form, like_count: e.target.value })} />
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">Comments</label>
              <input className="w-full border rounded px-2 py-1.5 text-sm" type="number" value={form.comment_count}
                onChange={e => setForm({ ...form, comment_count: e.target.value })} />
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">Shares</label>
              <input className="w-full border rounded px-2 py-1.5 text-sm" type="number" value={form.share_count}
                onChange={e => setForm({ ...form, share_count: e.target.value })} />
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">Duration (s)</label>
              <input className="w-full border rounded px-2 py-1.5 text-sm" type="number" value={form.duration_sec}
                onChange={e => setForm({ ...form, duration_sec: e.target.value })} />
            </div>
          </div>

          <button onClick={submit} disabled={submitting || (!form.caption && !form.hook_text)}
            className="bg-[#E63946] text-white px-5 py-2 rounded font-semibold text-sm disabled:opacity-50">
            {submitting ? "Analysing with Claude..." : "Extract Lesson"}
          </button>
          {msg && <p className="text-sm text-green-600">{msg}</p>}
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      </div>

      {/* Lessons list */}
      <h2 className="font-bold text-lg mb-3">Lessons ({lessons.filter(l => l.active).length} active · {lessons.length} total)</h2>
      {loading ? (
        <p className="text-gray-500 text-sm">Loading...</p>
      ) : lessons.length === 0 ? (
        <div className="bg-white border rounded-lg p-6 text-center text-gray-500 text-sm">
          No lessons yet. Paste a viral TikTok above to get started.
        </div>
      ) : (
        <div className="space-y-3">
          {lessons.map((l) => (
            <div key={l.id} className={`bg-white border rounded-lg p-4 ${!l.active ? "opacity-50" : ""}`}>
              <div className="flex items-start justify-between mb-2">
                <div className="flex items-center gap-2 flex-wrap">
                  {l.is_own_content && (
                    <span className="bg-[#E63946] text-white px-2 py-0.5 rounded text-[10px] font-bold">SUREPATH OWN</span>
                  )}
                  <span className="bg-red-100 text-red-700 px-2 py-0.5 rounded text-[10px] font-bold">{l.hook_style}</span>
                  {l.rag_chunk_key && (
                    <span className="bg-purple-100 text-purple-700 px-2 py-0.5 rounded text-[10px] font-bold" title="Embedded in RAG layer — surfaces in semantic retrieval">IN RAG</span>
                  )}
                  {l.view_count && <span className="text-xs text-gray-500">{Number(l.view_count).toLocaleString()} views</span>}
                  {l.like_count && <span className="text-xs text-gray-500">{Number(l.like_count).toLocaleString()} likes</span>}
                  {l.score && <span className="text-xs text-gray-400">score {Number(l.score).toFixed(0)}</span>}
                </div>
                <div className="flex gap-1">
                  <button onClick={() => toggleActive(l.id, l.active)} className={`text-xs px-2 py-0.5 rounded ${l.active ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-600"}`}>
                    {l.active ? "Active" : "Inactive"}
                  </button>
                  <button onClick={() => deleteLesson(l.id)} className="text-xs px-2 py-0.5 rounded bg-red-50 text-red-600">Delete</button>
                </div>
              </div>
              <p className="font-medium text-sm mb-1">{l.one_line_lesson}</p>
              <p className="text-xs text-gray-600 mb-2">{l.what_worked}</p>
              {l.hook_text && <p className="text-xs italic text-gray-500">Hook: &ldquo;{l.hook_text}&rdquo;</p>}
              {l.source_url && (
                <a href={l.source_url} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 underline">View source</a>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
