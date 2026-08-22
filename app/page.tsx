"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import ZodiacSidebar from "./components/ZodiacSidebar";

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
 * `h-full flex flex-col`). Autoscroll to latest. Duplicate-send is
 * prevented by disabling the input while a send is in flight.
 *
 * UI fixes batch, live feedback at localhost:3311 (Chat/Horoscope/People
 * tabs removed — item 9): the header is now logo+wordmark only; Horoscope
 * and People are reached from links in the sidebar (ZodiacSidebar.tsx),
 * which persists on this page regardless of what's happening in chat —
 * a simpler pattern than an in-page tab switch, and consistent with how
 * People already worked as its own route before this change.
 *
 * The input is a fixed-height (not auto-growing) textarea specifically so
 * the overall layout never shifts as you type (item 8) while still
 * comfortably fitting multi-line messages (item 6) — Enter sends,
 * Shift+Enter inserts a newline, matching standard chat-input behavior.
 * The attachment status notice is an overlay (fixed position, own stacking
 * context), not inline flow, for the same static-layout reason.
 *
 * Item 13: on a genuinely fresh session (the event log has never seen a
 * message_sent from this user — checked server-side via /api/first-session,
 * never inferred from this component's own empty local state, since that's
 * true on every reload) Enso proactively opens with a fixed line rather
 * than waiting for the user to speak first. That opener is rendered
 * directly, never round-tripped through /api/chat — see
 * src/persona/proactiveOpener.ts for why it's deliberately not persisted.
 *
 * Visual-system pass (batch 2, items 1/2/4/5): the header now uses
 * enso-mark.png — a crop of just the brush-stroke ring, generated from
 * public/assets/Enso.png (which bundles the ring with baked-in "ENSO
 * INTELLIGENCE" pixel text) — because the OLD header rendered that whole
 * source image at 44x44px: the baked-in text was both illegible at that
 * size AND redundant with the separate "Enso" HTML label already next to
 * it. The wordmark itself switched from font-serif to a bold, wide-tracked
 * sans, matching the actual typography baked into the brand mark (checked
 * by reading the source PNG directly, not assumed) rather than an
 * unrelated serif. Logo, input, attachment button, and Send button were
 * all sized as one pass (w-16 mark / h-28 input+button) so enlarging the
 * identity mark didn't leave the input row looking undersized by
 * comparison. The red accent (var(--enso-red), the same color as the
 * mark's brush stroke) is now the ONE consistent accent — user bubbles and
 * Send button — while Enso's own bubbles stay recessive (white, a thin
 * border, near-black text) so the accent reads as "the user's voice /
 * action," not decoration.
 */
export default function Page() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [attachmentStatus, setAttachmentStatus] = useState<AttachmentStatus | null>(null);
  const [sidebarRefreshSignal, setSidebarRefreshSignal] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/first-session")
      .then((r) => r.json())
      .then((json: { isFirstSession: boolean; openerText: string }) => {
        if (!cancelled && json.isFirstSession) {
          setMessages((prev) => (prev.length === 0 ? [{ id: crypto.randomUUID(), role: "enso", text: json.openerText }] : prev));
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  useEffect(() => {
    if (!attachmentStatus) return;
    const timer = setTimeout(() => setAttachmentStatus(null), 6000);
    return () => clearTimeout(timer);
  }, [attachmentStatus]);

  async function sendMessage() {
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
        // Item 7: /api/chat awaits extraction (refreshMemoryAfterTurn)
        // before responding, so any attribute — a just-established
        // birthdate, say — is already committed by the time this resolves.
        // Bump the sidebar's refresh signal so it re-fetches instead of
        // only ever checking once on page load.
        setSidebarRefreshSignal((n) => n + 1);
      }
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
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
      <header className="shrink-0 flex items-center gap-4 px-6 py-4 border-b border-stone-200">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/assets/enso-mark.png" alt="" className="w-16 h-16" />
        <span className="text-4xl font-bold tracking-wide" style={{ color: "var(--enso-ink)" }}>
          Enso
        </span>
      </header>

      <div className="flex-1 flex min-h-0">
        <div className="flex-1 flex flex-col min-h-0">
          <div ref={listRef} className="flex-1 overflow-y-auto min-h-0 p-4 flex flex-col gap-3">
            {messages.map((m) => (
              <div
                key={m.id}
                className={`max-w-lg rounded-lg px-4 py-3 text-base whitespace-pre-wrap ${
                  m.role === "user" ? "self-end text-white" : "self-start bg-white border border-stone-200"
                }`}
                style={m.role === "user" ? { backgroundColor: "var(--enso-red)", color: "#faf7f2" } : { color: "var(--enso-ink)" }}
              >
                {m.text}
              </div>
            ))}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void sendMessage();
            }}
            className="shrink-0 flex items-stretch gap-3 p-4 border-t border-stone-200"
            style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
          >
            <input ref={fileInputRef} type="file" onChange={handleFileChange} className="hidden" id="attachment-input" />
            <label
              htmlFor="attachment-input"
              className="shrink-0 w-14 h-28 flex items-center justify-center cursor-pointer rounded-xl bg-stone-100 border border-stone-300 text-stone-600 hover:bg-stone-200"
              title="Attach a file"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
            </label>
            <textarea
              ref={textareaRef}
              autoFocus
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={sending}
              placeholder="Tell Enso what's on your mind... (Enter to send, Shift+Enter for a new line)"
              rows={4}
              className="flex-1 h-28 resize-none rounded-xl px-4 py-3 text-base bg-white border border-stone-300 focus:outline-none focus:ring-2 focus:ring-stone-300 disabled:opacity-50 overflow-y-auto"
            />
            <button
              type="submit"
              disabled={sending || !input.trim()}
              className="shrink-0 h-28 rounded-xl text-white px-6 text-base font-medium disabled:opacity-50 hover:opacity-90"
              style={{ backgroundColor: "var(--enso-red)" }}
            >
              Send
            </button>
          </form>
        </div>

        <ZodiacSidebar refreshSignal={sidebarRefreshSignal} />
      </div>

      {attachmentStatus && (
        <div className="fixed bottom-28 left-4 max-w-sm rounded-lg bg-stone-800 text-white text-xs px-3 py-2 shadow-lg z-10">
          {attachmentStatus.filename}: {attachmentStatus.extractionSucceeded ? "extraction succeeded" : `extraction failed — ${attachmentStatus.extractionError}`}
        </div>
      )}
    </div>
  );
}
