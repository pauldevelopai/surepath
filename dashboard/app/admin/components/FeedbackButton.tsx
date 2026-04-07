"use client";
import { useState } from "react";
import { usePathname } from "next/navigation";

export default function FeedbackButton() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [section, setSection] = useState("general");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const pathname = usePathname();

  async function submit() {
    if (!text.trim()) return;
    setSending(true);
    await fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        feedback: text,
        section,
        page_url: pathname,
      }),
    });
    setSending(false);
    setSent(true);
    setText("");
    setSection("general");
    setTimeout(() => { setSent(false); setOpen(false); }, 1500);
  }

  if (sent) {
    return (
      <div className="fixed bottom-6 left-6 z-50 bg-green-600 text-white px-4 py-3 rounded-lg shadow-lg text-sm font-medium print:hidden">
        Feedback saved
      </div>
    );
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-6 left-6 z-50 h-10 px-4 rounded-full bg-green-600 text-white shadow-lg hover:bg-green-700 flex items-center justify-center gap-2 text-xs font-medium print:hidden"
        title="Submit feedback"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        Feedback
      </button>
    );
  }

  return (
    <div className="fixed bottom-6 left-6 z-50 w-80 bg-white border rounded-lg shadow-xl print:hidden">
      <div className="flex justify-between items-center px-4 py-2 border-b bg-green-600 rounded-t-lg">
        <span className="text-white text-sm font-bold">Feedback</span>
        <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-white text-lg">&times;</button>
      </div>
      <div className="p-4">
        <div className="text-[10px] text-gray-400 mb-2">Page: {pathname}</div>
        <select
          className="border rounded px-2 py-1 text-xs w-full mb-2"
          value={section}
          onChange={e => setSection(e.target.value)}
        >
          <option value="bug">Bug Report</option>
          <option value="data_quality">Data Quality</option>
          <option value="feature_request">Feature Request</option>
          <option value="report">Report Quality</option>
          <option value="general">General</option>
        </select>
        <textarea
          className="border rounded px-2 py-1 text-xs w-full mb-2"
          rows={4}
          placeholder="What's wrong, what's missing, or what could be better?"
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && e.metaKey) submit(); }}
          autoFocus
        />
        <div className="flex justify-between items-center">
          <span className="text-[9px] text-gray-300">Cmd+Enter to send</span>
          <button
            onClick={submit}
            disabled={sending || !text.trim()}
            className="px-4 py-1.5 bg-green-600 text-white text-xs rounded font-bold hover:bg-green-700 disabled:opacity-50"
          >
            {sending ? "Sending..." : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
