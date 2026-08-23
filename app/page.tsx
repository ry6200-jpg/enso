"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import ZodiacSidebar from "./components/ZodiacSidebar";

interface ChatMessage {
  id: string;
  role: "user" | "enso";
  text: string;
  attachmentFilename?: string;
}

interface AttachmentStatus {
  filename: string;
  extractionSucceeded: boolean;
  extractionError: string | null;
}

interface LocationContextState {
  placeName: string | null;
  timezone: string | null;
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
 * Item 13: on a genuinely fresh session Enso proactively opens with a
 * fixed line rather than waiting for the user to speak first. That opener
 * is never round-tripped through /api/chat — see
 * src/persona/proactiveOpener.ts for why it's deliberately not persisted.
 * The text itself is owned server-side by GET /api/history (it substitutes
 * the opener for an empty result), not imported here — a prior version of
 * this file imported proactiveOpener.ts directly for the same fallback,
 * which both duplicated the string and broke the Turbopack client bundle
 * (see next.config.ts: Turbopack can't resolve this codebase's .js-
 * suffixed imports the way webpack can, so a src/ import that's fine
 * server-side can still fail once it's reachable from client code).
 *
 * Item 9 (conversation appeared to vanish on refresh — confirmed via
 * direct dev-data inspection that the event log had every message intact
 * the whole time; this was a pure display bug): messages now hydrate from
 * GET /api/history on mount instead of always starting empty. Whether a
 * session is "genuinely fresh" (for the item 13 opener above) is now
 * simply whether that history came back empty — there's no separate
 * concept or endpoint for it, since a real event log with zero messages
 * and "first session" are the exact same fact.
 *
 * Item 8 (attachment function reported as "doesn't work at all"): the
 * real bug was that selecting a file immediately fired its own,
 * completely disconnected upload — nothing ever told the chat pipeline an
 * attachment existed, so its extracted content never reached a reply no
 * matter what you typed afterward. A file is now staged on selection
 * (pendingFile below) and only actually uploaded at Send time, together
 * with whatever text (or no text — R1/EN-064 already supported an
 * attachment-only message; the /api/chat route just never allowed one
 * through) — see src/conversation/chatPipeline.ts's attachmentEventId
 * handling for where the content actually gets injected.
 *
 * Focus-retention fix: the textarea is `disabled={sending}`, and a
 * disabled form control is auto-blurred by the browser the instant it
 * becomes disabled (a disabled element cannot hold focus, full stop) —
 * so focus was already gone the moment a send started, on every single
 * send, not just in long sessions. The old recovery attempt called
 * `textareaRef.current?.focus()` synchronously right after
 * `setSending(false)` in the same tick — but that state update only
 * SCHEDULES a re-render; the DOM's `disabled` attribute hadn't actually
 * been removed yet at that exact instant, so `.focus()` silently failed
 * against a still-disabled node. Fixed by moving the refocus into a
 * `useEffect` keyed on a dedicated `refocusInputSignal` counter, bumped
 * only at the two moments that need it (send-complete, file selected) —
 * effects run AFTER React commits the DOM, so by the time this one fires
 * the textarea is genuinely re-enabled and `.focus()` actually lands. The
 * same effect is guarded inline against an active text selection in the
 * transcript and against focus sitting in a genuinely separate control
 * (anything outside `formRef`) — event-tied to the explicit bumps above,
 * never a blanket per-render effect.
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
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [sidebarRefreshSignal, setSidebarRefreshSignal] = useState(0);
  const [refocusInputSignal, setRefocusInputSignal] = useState(0);
  // Ambient current-location (see enso-rebuild-requirements.md's CORE
  // DISTINCTION) — timezone is computed once on mount (zero permission
  // cost); placeName stays null until/unless geolocation resolves. Neither
  // field is ever the user's residence — this is ephemeral per-turn
  // context, resent with every /api/chat call, never stored beyond state.
  const [locationContext, setLocationContext] = useState<LocationContextState>({ placeName: null, timezone: null });
  const [locationBlocked, setLocationBlocked] = useState(false);
  const geolocationAttemptedRef = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/history")
      .then((r) => r.json())
      .then((json: { messages: ChatMessage[] }) => {
        if (cancelled) return;
        setMessages(json.messages);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Timezone alone (Tier 3): zero permission cost, always collected — safe
  // to grab on mount, unlike geolocation below which is gated behind an
  // explicit, in-context ask (never on first page load).
  useEffect(() => {
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      setLocationContext((prev) => ({ ...prev, timezone }));
    } catch {
      // Unsupported/unavailable — location context simply stays timezone-less; never blocks anything.
    }
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  useEffect(() => {
    if (!attachmentStatus) return;
    const timer = setTimeout(() => setAttachmentStatus(null), 6000);
    return () => clearTimeout(timer);
  }, [attachmentStatus]);

  // Fires ONLY when refocusInputSignal is explicitly bumped (after a send
  // completes, after a file is selected) — never on every render. Runs
  // inside an effect, not inline, specifically so it executes AFTER React
  // has committed the DOM change that re-enables the textarea (see the
  // focus-retention fix note above the component).
  useEffect(() => {
    if (refocusInputSignal === 0) return; // skip the initial mount call — autoFocus already owns first paint
    const selection = window.getSelection();
    if (selection && selection.toString().length > 0) return; // never yank focus out of an active transcript selection
    const active = document.activeElement;
    const stillWithinThisInteraction = active === null || active === document.body || active === textareaRef.current || (active instanceof Node && formRef.current?.contains(active));
    if (!stillWithinThisInteraction) return; // focus is in a genuinely separate control — leave it alone
    textareaRef.current?.focus();
  }, [refocusInputSignal]);

  // Tier 1 (browser geolocation -> server-side reverse geocode -> place
  // name). Fire-and-forget: never blocks a send, never awaited by the
  // caller — the very first message of a session simply goes out without
  // it, and every later one carries it once this resolves (usually well
  // under a second). Denial is PERMANENT and SILENT (never re-prompt,
  // never mention it, never degrade the conversation) — the browser's own
  // permission memory already enforces "never re-prompt" for us; this
  // function's only additional state is locationBlocked, purely to steer
  // the "grant later" button's own label, never surfaced to Enso.
  function attemptGeolocation() {
    if (!("geolocation" in navigator)) return;
    navigator.geolocation.getCurrentPosition(
      (position) => {
        // The success callback firing at all means permission is granted,
        // regardless of whether reverse-geocoding itself later succeeds —
        // clears a stale "blocked" state from an earlier denial that was
        // since reversed in the browser's own site settings.
        setLocationBlocked(false);
        const { latitude, longitude } = position.coords; // read once, never stored — discarded the instant this callback returns
        fetch("/api/location", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ latitude, longitude }) })
          .then((res) => res.json())
          .then((json: { placeName: string | null }) => {
            if (json.placeName) setLocationContext((prev) => ({ ...prev, placeName: json.placeName }));
          })
          .catch(() => {}); // Tier 2/3 take over server-side regardless
      },
      (error) => {
        if (error.code === error.PERMISSION_DENIED) setLocationBlocked(true);
        // POSITION_UNAVAILABLE / TIMEOUT: transient, not a denial — locationBlocked stays false so a later click (or session) can retry.
      },
      { timeout: 5000, maximumAge: 300000 }
    );
  }

  async function sendMessage() {
    const text = input.trim();
    const file = pendingFile;
    if ((!text && !file) || sending) return; // duplicate-send guard; text OR a file is enough (item 8)

    // Ask once, in context — the first time the owner actually sends
    // something, never on page load, and never again after this session's
    // one attempt (the browser's own permission memory handles "never
    // re-prompt" for an actual denial; this ref just stops us calling
    // getCurrentPosition again this session once we already have).
    if (!geolocationAttemptedRef.current) {
      geolocationAttemptedRef.current = true;
      attemptGeolocation();
    }

    setSending(true);
    setInput("");
    setPendingFile(null);
    setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "user", text, attachmentFilename: file?.name }]);

    try {
      let attachmentEventId: string | undefined;
      if (file) {
        const formData = new FormData();
        formData.append("file", file);
        const uploadRes = await fetch("/api/attachments", { method: "POST", body: formData });
        const uploadJson = await uploadRes.json();
        if (!uploadRes.ok) {
          setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "enso", text: `(couldn't attach ${file.name}: ${uploadJson.error})` }]);
          return;
        }
        attachmentEventId = uploadJson.uploadEventId;
        setAttachmentStatus({ filename: file.name, extractionSucceeded: uploadJson.extractionSucceeded, extractionError: uploadJson.extractionError });
      }

      // Part B-0: recentTurns is no longer sent — the server derives the
      // current session's window itself from the event log, which is the
      // real source of truth (see app/api/chat/route.ts). The client's own
      // message state was never guaranteed to reflect what the server
      // actually held, and hardcoding "last 6" here was the reason Enso
      // used to be blind past 6 turns within a single long session.
      const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, attachmentEventId, locationContext }) });
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
      setRefocusInputSignal((n) => n + 1);
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) setPendingFile(file);
    if (fileInputRef.current) fileInputRef.current.value = "";
    // The native file picker leaves focus on the (hidden) file input once
    // it closes, not the textarea — bump the same signal so the user can
    // keep typing without reaching for the mouse.
    setRefocusInputSignal((n) => n + 1);
  }

  return (
    <div className="h-full flex flex-col">
      <header className="shrink-0 flex items-center gap-4 px-6 py-4 border-b border-stone-200">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/assets/enso-mark.png" alt="" className="w-16 h-16" />
        <span className="text-4xl font-bold tracking-wide" style={{ color: "var(--enso-ink)" }}>
          Enso
        </span>
        {/*
          "Provide a way to grant it later," scoped precisely: visible ONLY
          when permission was explicitly denied — never on a fresh/prompt
          state (nothing to "grant later" yet — the one-time first-send
          attempt already covers that), and never once granted (a
          permanent indicator would be a standing solicitation, which
          directly contradicts "denial is permanent and silent"). This is
          the only state locationBlocked can accurately represent: it's
          set true only from a real PERMISSION_DENIED, and reset false the
          moment any later attempt actually succeeds (see
          attemptGeolocation) — so it never lies in either direction.
          Clicking can't force the native prompt back open once truly
          denied (no web API does that) — the tooltip is honest about that
          and points at the real fix instead of promising one it can't
          deliver.
        */}
        {locationBlocked && (
          <button
            type="button"
            onClick={attemptGeolocation}
            title="Location access is blocked — check your browser's site settings to allow it"
            className="ml-auto text-sm text-stone-400 hover:text-stone-600"
          >
            📍
          </button>
        )}
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
                {m.attachmentFilename && <div className="text-xs opacity-80 mb-1">Attached: {m.attachmentFilename}</div>}
                {m.text}
              </div>
            ))}
          </div>

          <form
            ref={formRef}
            onSubmit={(e) => {
              e.preventDefault();
              void sendMessage();
            }}
            className="shrink-0 flex flex-col gap-2 p-4 border-t border-stone-200"
            style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
          >
            {pendingFile && (
              <div className="flex items-center gap-2 text-sm text-stone-600 bg-stone-100 border border-stone-300 rounded-lg px-3 py-1.5 w-fit">
                <span>{pendingFile.name}</span>
                <button type="button" onClick={() => setPendingFile(null)} className="text-stone-400 hover:text-stone-700" title="Remove attachment">
                  ×
                </button>
              </div>
            )}
            <div className="flex items-stretch gap-3">
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
                disabled={sending || (!input.trim() && !pendingFile)}
                className="shrink-0 h-28 rounded-xl text-white px-6 text-base font-medium disabled:opacity-50 hover:opacity-90"
                style={{ backgroundColor: "var(--enso-red)" }}
              >
                Send
              </button>
            </div>
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
