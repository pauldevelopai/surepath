"use client";
import { useEffect, useState } from "react";
import { formatZAR } from "@/lib/format";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Video = Record<string, any>;

function getStatus(v: Video): { label: string; colour: string } {
  if (v.tiktok_post_id || v.instagram_post_id || v.youtube_post_id) {
    return { label: "Posted", colour: "bg-green-100 text-green-700" };
  }
  if (v.final_video_url) return { label: "Composed", colour: "bg-blue-100 text-blue-700" };
  if (v.srt_content) return { label: "Captions ready", colour: "bg-indigo-100 text-indigo-700" };
  if (v.audio_url) return { label: "Audio ready", colour: "bg-amber-100 text-amber-700" };
  if (v.script) return { label: "Draft", colour: "bg-gray-100 text-gray-600" };
  return { label: "Empty", colour: "bg-red-100 text-red-600" };
}

function timeSince(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / 86400000);
  if (days > 0) return `${days}d ago`;
  const hours = Math.floor(diff / 3600000);
  if (hours > 0) return `${hours}h ago`;
  const mins = Math.floor(diff / 60000);
  return `${mins}m ago`;
}

export default function VideosPage() {
  const [videos, setVideos] = useState<Video[]>([]);
  const [loading, setLoading] = useState(true);
  const [posting, setPosting] = useState<number | null>(null);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [tiktok, setTiktok] = useState<{ connected: boolean } | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);

  async function load(p = page) {
    setLoading(true);
    const res = await fetch(`/api/content?action=list&page=${p}`);
    const json = await res.json();
    setVideos(json.videos || []);
    setTotalPages(json.totalPages || 1);
    setTotal(json.total || 0);
    setLoading(false);
  }

  async function markDownloaded(id: number) {
    await fetch("/api/content", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "mark_downloaded", post_id: id }),
    });
    setVideos((vs) => vs.map((v) => v.id === id ? { ...v, downloaded_at: new Date().toISOString() } : v));
  }

  function isNewToday(v: Video): boolean {
    if (!v.created_at) return false;
    const created = new Date(v.created_at);
    const now = new Date();
    return created.toDateString() === now.toDateString();
  }

  useEffect(() => {
    load(page);
  }, [page]);

  useEffect(() => {
    fetch("/api/tiktok/status").then(r => r.json()).then(setTiktok);
  }, []);

  async function deleteVideo(id: number) {
    if (!confirm("Delete this video?")) return;
    await fetch(`/api/content?id=${id}`, { method: "DELETE" });
    load();
  }

  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [hashtags, setHashtags] = useState<string[]>([]);

  useEffect(() => {
    fetch("/api/content/hashtags").then(r => r.json()).then(data => {
      if (Array.isArray(data.hashtags)) {
        setHashtags(data.hashtags.map((h: { tag: string }) => `#${h.tag}`));
      }
    }).catch(() => {});
  }, []);

  function buildCaption(v: Video): string {
    const script = (v.script || "").trim();
    const tags = hashtags.length > 0
      ? hashtags.join(" ")
      : "#surepath #property #southafrica #propertyadvice #homebuying #realestate";
    // WhatsApp contact goes FIRST — users see it before anything else
    return `WhatsApp: +27 79 219 8649\n\n${script}\n\nGet your Surepath property report — we find the hidden risks nobody else tells you about.\n\n${tags}`;
  }

  async function copyCaption(v: Video) {
    const text = buildCaption(v);
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(v.id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      // Fallback for browsers blocking clipboard API
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopiedId(v.id);
      setTimeout(() => setCopiedId(null), 2000);
    }
  }

  async function postToTikTok(id: number) {
    setPosting(id);
    setMsg("");
    setError("");
    const res = await fetch("/api/tiktok/post", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ post_id: id }),
    });
    const json = await res.json();
    setPosting(null);
    if (json.error) setError(json.error);
    else {
      setMsg(`Posted to TikTok (${json.publish_id})`);
      load();
    }
  }

  const counts = {
    total: videos.length,
    posted: videos.filter(v => v.tiktok_post_id || v.instagram_post_id || v.youtube_post_id).length,
    composed: videos.filter(v => v.final_video_url && !v.tiktok_post_id && !v.instagram_post_id && !v.youtube_post_id).length,
    drafts: videos.filter(v => !v.final_video_url).length,
  };

  return (
    <div className="max-w-7xl">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold mb-1">Videos</h1>
          <p className="text-sm text-gray-500">Your 10-second Nico reels — preview, edit, and publish</p>
        </div>
        <a href="/admin/content" className="bg-[#E63946] text-white px-4 py-2 rounded text-sm font-semibold hover:bg-red-700">
          + New Video
        </a>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        <div className="bg-white border rounded-lg p-3">
          <div className="text-2xl font-bold">{counts.total}</div>
          <div className="text-xs text-gray-500">Total</div>
        </div>
        <div className="bg-white border rounded-lg p-3">
          <div className="text-2xl font-bold text-gray-700">{counts.drafts}</div>
          <div className="text-xs text-gray-500">In progress</div>
        </div>
        <div className="bg-white border rounded-lg p-3">
          <div className="text-2xl font-bold text-blue-700">{counts.composed}</div>
          <div className="text-xs text-gray-500">Ready to publish</div>
        </div>
        <div className="bg-white border rounded-lg p-3">
          <div className="text-2xl font-bold text-green-700">{counts.posted}</div>
          <div className="text-xs text-gray-500">Posted</div>
        </div>
      </div>

      {msg && <p className="mb-3 text-sm text-green-600">{msg}</p>}
      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

      {loading ? (
        <p className="text-gray-500 text-sm">Loading...</p>
      ) : videos.length === 0 ? (
        <div className="bg-white border rounded-lg p-8 text-center">
          <p className="text-gray-500 mb-3">No videos yet</p>
          <a href="/admin/content" className="bg-[#E63946] text-white px-4 py-2 rounded text-sm font-semibold hover:bg-red-700">
            Create your first video
          </a>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {videos.map((v) => {
            const status = getStatus(v);
            const address = v.address_normalised || v.address_raw || "—";
            return (
              <div key={v.id} className="bg-white border rounded-lg overflow-hidden flex flex-col">
                {/* Video preview */}
                {v.final_video_url ? (
                  <video
                    src={v.final_video_url}
                    controls
                    className="w-full aspect-[9/16] bg-black object-cover"
                  />
                ) : v.audio_url ? (
                  <div className="w-full aspect-[9/16] bg-gray-50 flex items-center justify-center">
                    <div className="text-center p-4">
                      <div className="text-gray-400 text-xs mb-2">Audio only (no video yet)</div>
                      <audio src={v.audio_url} controls className="w-full max-w-[240px]" />
                    </div>
                  </div>
                ) : (
                  <div className="w-full aspect-[9/16] bg-gray-50 flex items-center justify-center text-gray-400 text-sm">
                    No preview yet
                  </div>
                )}

                {/* Info */}
                <div className="p-3 flex-1 flex flex-col">
                  <div className="flex items-center gap-1.5 mb-2 flex-wrap">
                    <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${status.colour}`}>{status.label}</span>
                    {isNewToday(v) && (
                      <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-[#E63946] text-white animate-pulse">NEW TODAY</span>
                    )}
                    {v.downloaded_at && (
                      <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-gray-900 text-white">DOWNLOADED</span>
                    )}
                    <span className="text-[10px] text-gray-400">{timeSince(v.created_at)}</span>
                    <span className="text-[10px] text-gray-400 ml-auto">#{v.id}</span>
                  </div>

                  <div className="text-xs text-gray-600 font-medium truncate mb-1">{address}</div>
                  {v.asking_price && (
                    <div className="text-[11px] text-gray-500 mb-2">{formatZAR(v.asking_price)}</div>
                  )}

                  <p className="text-xs text-gray-700 line-clamp-3 flex-1">{v.script || "No script"}</p>

                  {/* Copyable caption for manual posting */}
                  {v.script && (
                    <div className="mt-2 border-t pt-2">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[10px] font-bold text-gray-500 uppercase">Caption for TikTok</span>
                        <button
                          onClick={() => copyCaption(v)}
                          className={`px-2 py-0.5 rounded text-[10px] font-semibold ${copiedId === v.id ? "bg-green-600 text-white" : "bg-gray-100 hover:bg-gray-200 text-gray-700"}`}
                        >
                          {copiedId === v.id ? "Copied!" : "Copy"}
                        </button>
                      </div>
                      <textarea
                        readOnly
                        value={buildCaption(v)}
                        className="w-full text-[10px] border rounded p-1.5 h-20 text-gray-600 bg-gray-50 font-mono"
                        onClick={(e) => (e.target as HTMLTextAreaElement).select()}
                      />
                    </div>
                  )}

                  {/* Actions */}
                  <div className="flex gap-1.5 mt-3 flex-wrap">
                    <a
                      href={`/admin/content?id=${v.id}`}
                      className="bg-gray-100 hover:bg-gray-200 text-gray-700 px-2 py-1 rounded text-xs"
                    >
                      Edit
                    </a>
                    {v.final_video_url && tiktok?.connected && !v.tiktok_post_id && (
                      <button
                        onClick={() => postToTikTok(v.id)}
                        disabled={posting === v.id}
                        className="bg-black text-white px-2 py-1 rounded text-xs hover:bg-gray-800 disabled:opacity-50"
                      >
                        {posting === v.id ? "Posting..." : "Post to TikTok"}
                      </button>
                    )}
                    {v.final_video_url && (
                      <>
                        <a
                          href={v.final_video_url}
                          download={`surepath-reel-${v.id}.mp4`}
                          onClick={() => markDownloaded(v.id)}
                          className="bg-[#25D366] hover:bg-green-600 text-white px-2 py-1 rounded text-xs font-semibold"
                        >
                          Download
                        </a>
                        <a
                          href={v.final_video_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="bg-gray-100 hover:bg-gray-200 text-gray-700 px-2 py-1 rounded text-xs"
                        >
                          Open
                        </a>
                      </>
                    )}
                    <button
                      onClick={() => deleteVideo(v.id)}
                      className="bg-red-50 hover:bg-red-100 text-red-600 px-2 py-1 rounded text-xs ml-auto"
                    >
                      Delete
                    </button>
                  </div>

                  {/* Posted platform tags */}
                  {(v.tiktok_post_id || v.instagram_post_id || v.youtube_post_id) && (
                    <div className="flex gap-1 mt-2 flex-wrap">
                      {v.tiktok_post_id && <span className="bg-black text-white px-1.5 py-0.5 rounded text-[9px]">TikTok</span>}
                      {v.instagram_post_id && <span className="bg-pink-600 text-white px-1.5 py-0.5 rounded text-[9px]">Instagram</span>}
                      {v.youtube_post_id && <span className="bg-red-600 text-white px-1.5 py-0.5 rounded text-[9px]">YouTube</span>}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 mt-6">
          <button
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
            className="px-3 py-1.5 rounded border bg-white text-sm disabled:opacity-40 hover:bg-gray-50"
          >
            ← Previous
          </button>
          <span className="text-sm text-gray-600">
            Page {page} of {totalPages} · {total} videos total
          </span>
          <button
            disabled={page >= totalPages}
            onClick={() => setPage(page + 1)}
            className="px-3 py-1.5 rounded border bg-white text-sm disabled:opacity-40 hover:bg-gray-50"
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
