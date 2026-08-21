"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import ZodiacSidebar from "./components/ZodiacSidebar";
import HoroscopeTab from "./components/HoroscopeTab";

interface ChatMessage {
  id: string;
  role: "user" | "enso";
  text: string;
}

interface AttachmentStatus {
  filename: string;
  extractionSucceeded: boolean;
  extractionError: string | null;
}

/**
 * EN-036 UI shell: pinned input (this page is `flex-1 overflow-y-auto` for
 * the message list, `shrink-0` for the input bar, inside layout.tsx's
 * `h-full flex flex-col` — the exact fix from the old repo, not a
 * reinvention). No tabs except Horoscope (EN-032). Autoscroll to latest.
 * Duplicate-send is prevented by disabling the input while a send is in
 * flight (EN-036 calls this out explicitly as never confirmed fixed in
 * Mirror — tested here by the disabled state, not left implicit).
 */
export default function Page() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [attachmentStatus, setAttachmentStatus] = useState<AttachmentStatus | null>(null);
  const [tab, setTab] = useState<"chat" | "horoscope">("chat");
  const listRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  async function send(e: FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || sending) return; // duplicate-send guard

    setSending(true);
    setInput("");
    const recentTurns = messages.slice(-6).map((m) => ({ role: m.role, text: m.text }));
    setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "user", text }]);

    try {
      const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, recentTurns }) });
      const json = await res.json();
      if (!res.ok) {
        setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "enso", text: `(reply failed — your message was still saved: ${json.error})` }]);
      } else {
        setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "enso", text: json.replyText }]);
      }
    } finally {
      setSending(false);
    }
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setAttachmentStatus(null);
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch("/api/attachments", { method: "POST", body: formData });
    const json = await res.json();
    setAttachmentStatus(res.ok ? { filename: file.name, extractionSucceeded: json.extractionSucceeded, extractionError: json.extractionError } : { filename: file.name, extractionSucceeded: false, extractionError: json.error });
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  return (
    <div className="h-full flex flex-col">
      <header className="shrink-0 flex items-center justify-between px-4 py-2 border-b border-stone-200">
        <div className="flex items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/assets/Enso.png" alt="Enso" className="w-7 h-7" />
          <span className="font-serif text-lg">Enso</span>
        </div>
        <nav className="flex items-center gap-4 text-sm">
          <button onClick={() => setTab("chat")} className={tab === "chat" ? "font-medium" : "text-stone-500"}>
            Chat
          </button>
          <button onClick={() => setTab("horoscope")} className={tab === "horoscope" ? "font-medium" : "text-stone-500"}>
            Horoscope
          </button>
          <Link href="/people" className="text-stone-500">
            People
          </Link>
        </nav>
      </header>

      <div className="flex-1 flex min-h-0">
        {tab === "chat" ? (
          <div className="flex-1 flex flex-col min-h-0">
            <div ref={listRef} className="flex-1 overflow-y-auto min-h-0 p-4 flex flex-col gap-3">
              {messages.map((m) => (
                <div key={m.id} className={`max-w-lg rounded-lg px-3 py-2 text-sm ${m.role === "user" ? "self-end bg-stone-800 text-white" : "self-start bg-stone-100"}`}>
                  {m.text}
                </div>
              ))}
            </div>

            {attachmentStatus && (
              <div className="shrink-0 px-4 py-1 text-xs text-stone-500 border-t border-stone-100">
                {attachmentStatus.filename}: {attachmentStatus.extractionSucceeded ? "extraction succeeded" : `extraction failed — ${attachmentStatus.extractionError}`}
              </div>
            )}

            <form onSubmit={send} className="shrink-0 flex gap-2 p-3 border-t border-stone-200" style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}>
              <input ref={fileInputRef} type="file" onChange={handleFileChange} className="hidden" id="attachment-input" />
              <label htmlFor="attachment-input" className="shrink-0 self-center cursor-pointer text-stone-500 text-xl px-2" title="Attach a file">
                +
              </label>
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                disabled={sending}
                placeholder="Tell Enso what's on your mind..."
                className="flex-1 border border-stone-300 rounded-full px-4 py-2 text-sm disabled:opacity-50"
              />
              <button type="submit" disabled={sending || !input.trim()} className="shrink-0 rounded-full bg-stone-800 text-white px-4 py-2 text-sm disabled:opacity-50">
                Send
              </button>
            </form>
          </div>
        ) : (
          <HoroscopeTab />
        )}

        {tab === "chat" && <ZodiacSidebar />}
      </div>
    </div>
  );
}
