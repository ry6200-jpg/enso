"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { User } from "firebase/auth";
import ZodiacSidebar from "./components/ZodiacSidebar";
import { authFetch, signInWithGoogle, signOut, watchAuthState } from "./lib/firebaseClient";
import { isPinnedToBottom } from "./lib/chatScroll";

interface ChatMessage {
  id: string;
  role: "user" | "enso";
  text: string;
  filename?: string;
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
 * Enter sends, Shift+Enter inserts a newline, matching standard chat-input
 * behavior. The attachment status notice is an overlay (fixed position,
 * own stacking context), not inline flow, so it never affects composer
 * layout regardless of the composer's own height.
 *
 * Mobile layout and scroll fixes batch superseded this input's original
 * fixed-height design: the textarea now auto-grows with its content (up
 * to ~6 lines, then scrolls internally — see the effect keyed on `input`
 * below) specifically BECAUSE a fixed height was the wrong call once
 * real-device feedback showed the opposite problem — a long message
 * pushed the latest reply out of view with nowhere to see it growing. The
 * message list shrinking to accommodate, and the newest message staying
 * visible throughout, is the scroll-pinning system further down this
 * file, not a layout property of the composer itself.
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
 *
 * Mobile layout fix batch: THE structural bug (real phone, real live
 * feedback) was ZodiacSidebar.tsx's `w-72 shrink-0` — an unconditional
 * 288px flex sibling with no breakpoint ever removing it, so a phone
 * viewport got the chat column PLUS 288px of sidebar it had no way to
 * actually see, and the whole page scrolled sideways to prove it. Diagnosed
 * to that exact cause rather than patched with `overflow-hidden` (which
 * would have hidden the symptom while the 288px was still being reserved).
 * Fix is structural: below `md`, ZodiacSidebar renders nothing inline at
 * all (`hidden md:flex`) — it becomes an off-canvas panel opened from a
 * small mark in the header, gated on `zodiacAvailable` so that entry point
 * exists only once the birthdate gate has actually unlocked content, per
 * the standing rule against a tap target that opens nothing. Keyboard-safe
 * input (item 3) is a layout.tsx change (`interactiveWidget:
 * "resizes-content"` + `h-dvh`), not anything here — this page's existing
 * flex-1/shrink-0 pinning (EN-036, above) already does the right thing
 * once the viewport itself resizes correctly under the keyboard.
 * isNarrowScreen (item 5) swaps the placeholder text only — a plain
 * string prop can't respond to a CSS media query on its own.
 *
 * Scroll/history/focus/zodiac batch: the native `autoFocus` prop this
 * mobile batch left alone turned out to never reliably work at all — see
 * the item-4 effect's own comment below for why (the textarea's actual
 * first mount is gated behind async auth resolution, well past this
 * component's real first commit, which native autoFocus doesn't account
 * for) — replaced with an explicit effect-driven focus call.
 */
export default function Page() {
  // Cloud migration prerequisite batch, item 1: real user identity via
  // Firebase Auth (Google sign-in). `authStatus` distinguishes "still
  // checking" from "confirmed signed out" so the sign-in screen never
  // flashes for an already-authenticated returning user. The allowlist
  // itself is enforced server-side only (lib/requireUser.ts on every
  // route) — this page never checks it directly; it just notices a 403
  // from the first real authenticated call and signs back out with an
  // honest message, so a rejected account never gets a confusing hang.
  const [user, setUser] = useState<User | null>(null);
  const [authStatus, setAuthStatus] = useState<"checking" | "signedOut" | "signedIn">("checking");
  const [authError, setAuthError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [attachmentStatus, setAttachmentStatus] = useState<AttachmentStatus | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [sidebarRefreshSignal, setSidebarRefreshSignal] = useState(0);
  const [refocusInputSignal, setRefocusInputSignal] = useState(0);
  // Mobile layout fix batch: the zodiac sidebar's mobile entry point (a
  // small mark in the header) must appear ONLY once the birthdate gate has
  // actually unlocked real content — never a tap target that opens an
  // empty/"not available yet" panel. ZodiacSidebar reports availability
  // here via a callback since the trigger button lives in the header, not
  // inside that component. mobileSidebarOpen is otherwise ordinary
  // open/close state for the off-canvas panel itself.
  const [zodiacAvailable, setZodiacAvailable] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  // Mobile layout and scroll fixes batch: the header shrank to a single
  // ~56px row, which had no room left for an inline "Sign out" text label
  // — it now lives in a small overflow menu (along with the read-only
  // signed-in email, so testers can confirm which Google account they're
  // on) opened from a ⋮ button. menuRef backs the click-outside-closes
  // handler below.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  // Below md (Tailwind's breakpoint, matching ZodiacSidebar's own `hidden
  // md:flex`), the desktop placeholder's parenthetical wraps to three lines
  // and explains a keyboard shortcut a phone doesn't have. matchMedia, not
  // a resize listener — fires on rotation/resize alike with no polling.
  const [isNarrowScreen, setIsNarrowScreen] = useState(false);
  // Ambient current-location (see enso-rebuild-requirements.md's CORE
  // DISTINCTION) — timezone is computed once on mount (zero permission
  // cost); placeName stays null until/unless geolocation resolves. Neither
  // field is ever the user's residence — this is ephemeral per-turn
  // context, resent with every /api/chat call, never stored beyond state.
  const [locationContext, setLocationContext] = useState<LocationContextState>({ placeName: null, timezone: null });
  const [locationBlocked, setLocationBlocked] = useState(false);
  // Confirmed live: this ref only guards ONE attempt per PAGE LOAD, not per
  // browser-permission-lifetime — a tab left open across a server restart
  // that newly enabled Tier 1 (e.g. GOOGLE_MAPS_API_KEY added) will NOT
  // retry on its own even though permission was already Allow, because
  // this ref was already tripped from an earlier attempt in that same
  // still-open tab. A hard reload is what re-runs the first-send attempt.
  // Looks like a bug to anyone who hits it without this context — it
  // isn't one; the browser's own permission memory was never the problem.
  const geolocationAttemptedRef = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  // Mobile layout and scroll fixes batch: contentRef is the actual message
  // content — listRef is the scroll container around it. Deliberately two
  // elements: a ResizeObserver on listRef alone wouldn't fire when a new
  // message is appended (the scroll container's OWN box stays whatever
  // flex-1 gives it; only its content's height changes), so the observer
  // that detects "a new message arrived" has to watch contentRef instead.
  const contentRef = useRef<HTMLDivElement>(null);
  // Whether the user is currently at (or within AUTO_SCROLL_THRESHOLD_PX
  // of) the bottom of the transcript — a ref, not state, because it's
  // written on every scroll event and read from ResizeObserver/
  // visualViewport callbacks that don't need a re-render themselves;
  // showJumpToBottom below is the one piece of this that actually needs
  // to trigger one.
  const isPinnedRef = useRef(true);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  // Item 4 (composer focus on load): guards the one-time initial focus
  // attempt below so it never re-fires on a later authStatus change (e.g.
  // a token refresh re-delivering "signedIn") — see that effect's own
  // comment for why this exists instead of the native autoFocus prop.
  const initialFocusDoneRef = useRef(false);

  useEffect(() => {
    return watchAuthState((u) => {
      setUser(u);
      setAuthStatus(u ? "signedIn" : "signedOut");
    });
  }, []);

  // Refresh-blank-chat batch: root cause was this effect depending on the
  // whole `user` OBJECT — Firebase's onIdTokenChanged reliably fires more
  // than once during page load (this project's own authDomain requires a
  // cross-origin iframe handshake for auth-state sync, and that can
  // deliver more than one callback, each with a NEW User object reference
  // for the same signed-in account — see watchAuthState in
  // firebaseClient.ts). Each firing re-ran this effect: the cleanup
  // discarded whatever the FIRST fetch returned (even a real, successful
  // response), while a SECOND concurrent fetch for the same uid raced the
  // first at the per-user checkout lock — confirmed live in production
  // logs as a real LockAcquisitionError on this exact route. Depending on
  // `user?.uid` (stable across those re-firings for the same account)
  // instead of `user` (a new object each time) means this now only really
  // re-runs on an actual sign-in/sign-out/account-change, eliminating the
  // self-collision at its source rather than papering over the race with
  // a retry.
  //
  // History only ever fetches once a real signed-in user is present — an
  // unauthenticated request would just 401 anyway, and this is also where
  // a non-allowlisted account gets caught: the server enforces the
  // allowlist on every route (lib/requireUser.ts), never this page, so a
  // 403 here is the first real signal that sign-in succeeded but the
  // account isn't permitted for this closed test — sign back out
  // immediately with an honest message rather than leaving a rejected
  // account looking at a silently-stuck blank chat.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    authFetch("/api/history")
      .then(async (r) => {
        if (r.status === 403) {
          const json = await r.json().catch(() => ({}));
          if (!cancelled) {
            setAuthError(json.error ?? "This account is not authorized for this closed test.");
            await signOut();
          }
          return null;
        }
        if (!r.ok) {
          // Fail loud, per the same discipline every other route on this
          // page already follows (see sendMessage's !res.ok branch) — a
          // blank chat with nothing in the console is its own bug. This
          // was previously indistinguishable from "genuinely no history
          // yet," which is exactly how the LockAcquisitionError race above
          // went unnoticed in the browser for as long as it did.
          const body = await r.json().catch(() => ({}));
          // eslint-disable-next-line no-console
          console.error(`GET /api/history failed (${r.status}): ${body.error ?? "no error message in response body"}`);
          return null;
        }
        return r.json();
      })
      .then((json: { messages: ChatMessage[] } | null) => {
        if (cancelled || !json) return;
        setMessages(json.messages);
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error("GET /api/history threw before a response was received:", err);
      });
    return () => {
      cancelled = true;
    };
  }, [user?.uid]);

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

  // Scroll-pinning system (mobile layout and scroll fixes batch). Replaces
  // a bare `useEffect(() => scrollTo(...), [messages])`, which was the
  // likely cause of the most important bug reported: it ran on every
  // messages-state change, but a React effect fires once React has
  // committed the DOM, NOT once the browser has actually finished layout
  // — a change that alters text wrapping (a long reply, a growing
  // composer shrinking the list) can still be mid-layout at that exact
  // moment, so scrolling "to the bottom" at that instant could scroll to
  // where the bottom WAS about to be, not where it ends up, leaving the
  // newest message exactly where it was reported: hidden behind or below
  // the composer. ResizeObserver fires after the browser has genuinely
  // recomputed layout for whatever it's observing, and the extra
  // requestAnimationFrame in scrollToBottomIfPinned below defers the
  // actual scrollTop write to the next paint-aligned frame on top of
  // that — belt and braces against exactly this class of timing bug,
  // never a bare setTimeout guess.
  //
  // One mechanism covers every case in the acceptance criteria uniformly,
  // rather than special-casing each: mount (history loads -> content
  // resizes), a new message arriving (content resizes), the composer
  // growing or shrinking (composer AND list both resize), and the
  // keyboard opening or closing (visualViewport resize, wired up below) —
  // all just call the same scrollToBottomIfPinned, which only actually
  // moves anything while isPinnedRef is true. Sending a message forces
  // isPinnedRef true first (see sendMessage) — an outgoing message the
  // user just sent should always bring them back to the bottom even if
  // they'd scrolled up; an INCOMING reply while they're deliberately
  // reading history must not interrupt that, which is exactly what
  // isPinnedRef being false (they scrolled up) already prevents.
  function scrollToBottomIfPinned() {
    if (!isPinnedRef.current) return;
    requestAnimationFrame(() => {
      const list = listRef.current;
      if (list) list.scrollTop = list.scrollHeight;
    });
  }

  // Tracks whether the user is still pinned to the bottom as they
  // manually scroll — the ONE thing that can set isPinnedRef back to
  // false (every other effect here only ever scrolls TO the bottom, never
  // away from it, so this is the sole source of truth for "they scrolled
  // up on purpose").
  //
  // Scroll/history/focus/zodiac batch, items 1+3: THE actual bug behind
  // "scroll does not move on send" and "initial scroll position is the
  // top" — confirmed structurally, not by timing/guesswork. This effect
  // (and the ResizeObserver one below) used to have an EMPTY dependency
  // array, meaning each is tied to the component's FIRST-EVER commit —
  // but `Page`'s early return means that first commit is ALWAYS the
  // auth-checking screen (authStatus !== "signedIn"), which doesn't
  // render listRef/contentRef/formRef at all. `if (!list) return;` then
  // silently no-ops, and because the deps array is `[]`, this effect
  // NEVER RUNS AGAIN for the rest of the page's life — not even once
  // authStatus flips to "signedIn" and the real chat UI (with real refs)
  // finally mounts. The listener is never attached, full stop, for the
  // entire session — which is exactly why it reproduced 100% of the time
  // rather than intermittently. A throwaway test harness that mounted the
  // chat UI directly (no auth-gated early return) never hit this, which
  // is why it passed there and nowhere else. Depending on `authStatus`
  // makes this effect re-run on every auth transition, including the one
  // that actually mounts the real DOM nodes — this is the SAME existing
  // effect finally attaching to the SAME existing DOM node, not a new
  // mechanism bolted on top.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    function handleScroll() {
      if (!listRef.current) return;
      const pinned = isPinnedToBottom(listRef.current.scrollTop, listRef.current.scrollHeight, listRef.current.clientHeight);
      isPinnedRef.current = pinned;
      setShowJumpToBottom(!pinned);
    }
    list.addEventListener("scroll", handleScroll, { passive: true });
    return () => list.removeEventListener("scroll", handleScroll);
  }, [authStatus]);

  // One ResizeObserver, three observation targets: contentRef (a message
  // was added/removed, or a bubble's own wrapped-text height changed),
  // listRef (the scroll container's own box changed — e.g. the composer
  // growing shrinks it, or the window/orientation changed), and formRef
  // (the composer itself growing or shrinking — attached directly per
  // this batch's spec, even though listRef's own resize would catch most
  // of the same cases indirectly; being explicit here doesn't rely on
  // that indirect path).
  //
  // Scroll/history/focus/zodiac batch, items 1+3: see the identical note
  // on the scroll-tracking effect above — this had the same `[]`-deps bug
  // (set up once, tied to the auth-checking screen's commit, where these
  // three refs are all null, and never retried), which is the actual
  // reason neither "scroll to bottom on send" nor "scroll to bottom on
  // initial load" ever fired in production. Depending on `authStatus`
  // re-attaches this same observer once the real DOM nodes exist.
  useEffect(() => {
    const content = contentRef.current;
    const list = listRef.current;
    const composer = formRef.current;
    if (!content || !list || !composer) return;
    const observer = new ResizeObserver(() => scrollToBottomIfPinned());
    observer.observe(content);
    observer.observe(list);
    observer.observe(composer);
    return () => observer.disconnect();
  }, [authStatus]);

  // The on-screen keyboard opening/closing changes window.visualViewport's
  // height (see layout.tsx's interactiveWidget: "resizes-content" — with
  // that set, Chrome/Android also resizes the LAYOUT viewport, which is
  // what actually moves the composer there, so ResizeObserver on the list
  // already re-pins on its own; this listener is what covers the browser
  // this project actually can't test locally, iOS Safari, where the
  // keyboard does NOT resize the layout viewport at all — ONLY
  // visualViewport moves, 'resize' firing once the keyboard has finished
  // animating in/out and 'scroll' firing repeatedly WHILE it animates
  // (iOS's visualViewport.offsetTop shifts during the transition — no
  // 'resize' event for that intermediate motion, only 'scroll'). Both
  // route through the exact same scrollToBottomIfPinned used everywhere
  // else, deliberately not a separate re-pin path, so ordering/behavior
  // stays identical regardless of which trigger fired.
  //
  // NOT verified against real iOS Safari — no device was available in
  // this environment. Guarded for `visualViewport` being undefined
  // (older browsers, some headless/test environments).
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    function handleViewportChange() {
      scrollToBottomIfPinned();
    }
    vv.addEventListener("resize", handleViewportChange);
    vv.addEventListener("scroll", handleViewportChange);
    return () => {
      vv.removeEventListener("resize", handleViewportChange);
      vv.removeEventListener("scroll", handleViewportChange);
    };
  }, []);

  function handleJumpToBottom() {
    isPinnedRef.current = true;
    setShowJumpToBottom(false);
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }

  // Composer growth batch: the textarea grows with its content instead of
  // staying a fixed height. `height: auto` first, THEN read scrollHeight —
  // skipping the reset would let scrollHeight only ever grow (it reflects
  // whatever height was last set, never shrinks itself), which is exactly
  // why deleting text back down wouldn't un-grow the box without this.
  // CSS alone (max-h-[10.619rem] + overflow-y-auto on the element, ~6
  // lines at this textarea's own font-size/line-height/padding/border —
  // font-size batch: 1.0625rem*1.45=1.540625rem/line * 6 = 9.24375rem,
  // + py-2.5's 1.25rem padding, + 0.125rem for the 1px top/bottom border
  // = 10.61875rem, rounded — see the textarea's own className for the
  // matching font-size/line-height this was computed from; if either
  // changes, this needs recomputing too) caps how tall this can actually
  // render and switches to internal scrolling past that — this effect
  // never needs to know that cap itself, it can request any height and
  // the box just won't grow past it. In rem, not px, like the font-size
  // it's derived from — a px cap would silently claw back the ~6-line
  // promise the moment the user's system font size is larger than
  // default, capping at fewer visible lines than intended.
  // Keyed on `input`, not wired into onChange directly: this also handles
  // the non-typing case where input is cleared programmatically after
  // send, correctly shrinking the box back down.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  // Closes the ⋮ menu on an outside click or Escape — standard disclosure
  // behavior; only wired up while the menu is actually open.
  useEffect(() => {
    if (!menuOpen) return;
    function handlePointerDown(e: PointerEvent) {
      if (menuRef.current && e.target instanceof Node && !menuRef.current.contains(e.target)) setMenuOpen(false);
    }
    function handleKeyDown(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    setIsNarrowScreen(mq.matches);
    const handleChange = (e: MediaQueryListEvent) => setIsNarrowScreen(e.matches);
    mq.addEventListener("change", handleChange);
    return () => mq.removeEventListener("change", handleChange);
  }, []);

  useEffect(() => {
    if (!attachmentStatus) return;
    const timer = setTimeout(() => setAttachmentStatus(null), 6000);
    return () => clearTimeout(timer);
  }, [attachmentStatus]);

  // Scroll/history/focus/zodiac batch, item 4: composer focus on load.
  // Used to rely on the textarea's native `autoFocus` prop, which is
  // unreliable here for the same structural reason items 1/3's
  // ResizeObserver was: the textarea only mounts once authStatus flips to
  // "signedIn" — well after the page's actual FIRST commit (the
  // auth-checking screen) — and some browsers additionally suppress a
  // freshly-inserted element's native autofocus once the user has already
  // interacted with the page at all (e.g. the "Sign in with Google" click
  // on the signed-out screen, which is real user interaction with THIS
  // page, on THIS load), which is exactly the path anyone without an
  // already-persisted Firebase session takes. An explicit effect-driven
  // `.focus()` call, tied to the same authStatus transition the
  // ResizeObserver fix above depends on, sidesteps both problems the same
  // way the send-focus effect right below already does.
  //
  // Mobile: deliberately NOT autofocused on load. Focusing a text input
  // from JS can force the on-screen keyboard open on Android Chrome even
  // without a real tap (iOS Safari tends to be more conservative here,
  // but this isn't a guarantee to build on across browsers/OS versions) —
  // opening the keyboard the instant the app loads would cover the
  // conversation the user came here to read, which the requirement
  // explicitly forbids. Checked directly via matchMedia at the moment
  // this fires, not the isNarrowScreen state (set by its own separate
  // mount effect, not guaranteed to have settled before this one runs).
  // The send-focus effect right below is intentionally NOT gated the same
  // way — by the time a send completes, the user was just typing with the
  // keyboard already open, so refocusing there never newly summons it.
  useEffect(() => {
    if (authStatus !== "signedIn" || initialFocusDoneRef.current) return;
    initialFocusDoneRef.current = true;
    if (window.matchMedia("(max-width: 767px)").matches) return;
    textareaRef.current?.focus();
  }, [authStatus]);

  // Fires ONLY when refocusInputSignal is explicitly bumped (after a send
  // completes, after a file is selected) — never on every render. Runs
  // inside an effect, not inline, specifically so it executes AFTER React
  // has committed the DOM change that re-enables the textarea (see the
  // focus-retention fix note above the component).
  useEffect(() => {
    if (refocusInputSignal === 0) return; // skip the initial mount call — the item-4 effect above owns first focus
    const selection = window.getSelection();
    if (selection && selection.toString().length > 0) return; // never yank focus out of an active transcript selection
    const active = document.activeElement;
    const stillWithinThisInteraction = active === null || active === document.body || active === textareaRef.current || (active instanceof Node && formRef.current?.contains(active));
    if (!stillWithinThisInteraction) return; // focus is in a genuinely separate control — leave it alone
    textareaRef.current?.focus();
  }, [refocusInputSignal]);

  // Diagnostic-only record of the last permission decision this browser
  // actually made — granted/denied with a timestamp, "never-asked" simply
  // being the absence of any entry. NOT an event, not entity_attributes,
  // never sent to /api/chat or seen by extraction — this exists solely so
  // a future diagnosis (like the last one) doesn't have to infer whether
  // permission was ever granted from indirect evidence. Read it directly
  // from a browser devtools console: localStorage.getItem("enso:locationPermissionLog").
  const LOCATION_PERMISSION_LOG_KEY = "enso:locationPermissionLog";
  function logLocationPermissionDecision(status: "granted" | "denied") {
    try {
      localStorage.setItem(LOCATION_PERMISSION_LOG_KEY, JSON.stringify({ status, timestamp: new Date().toISOString() }));
    } catch {
      // localStorage unavailable (private browsing, disabled) — diagnostic-only, never blocks anything.
    }
  }

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
        logLocationPermissionDecision("granted");
        const { latitude, longitude } = position.coords; // read once, never stored — discarded the instant this callback returns
        fetch("/api/location", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ latitude, longitude }) })
          .then((res) => res.json())
          .then((json: { placeName: string | null }) => {
            if (json.placeName) setLocationContext((prev) => ({ ...prev, placeName: json.placeName }));
          })
          .catch(() => {}); // Tier 2/3 take over server-side regardless
      },
      (error) => {
        if (error.code === error.PERMISSION_DENIED) {
          setLocationBlocked(true);
          logLocationPermissionDecision("denied");
        }
        // POSITION_UNAVAILABLE / TIMEOUT: transient, not a denial — locationBlocked stays false so a later click (or session) can retry, and no permission decision is logged (none was actually made).
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
    // Sending is always the user's own deliberate action — bring them back
    // to the bottom even if they'd scrolled up to read history, unlike an
    // incoming reply arriving passively while they're mid-scroll (which
    // must NOT interrupt that — see scrollToBottomIfPinned above).
    isPinnedRef.current = true;
    setShowJumpToBottom(false);
    setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "user", text, filename: file?.name }]);

    try {
      let attachmentEventId: string | undefined;
      if (file) {
        const formData = new FormData();
        formData.append("file", file);
        const uploadRes = await authFetch("/api/attachments", { method: "POST", body: formData });
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
      const res = await authFetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, attachmentEventId, locationContext }) });
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

  if (authStatus !== "signedIn") {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4 px-6">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/assets/enso-mark.png" alt="" className="w-16 h-16" />
        <span className="text-2xl font-bold tracking-wide" style={{ color: "var(--enso-ink)" }}>
          Enso
        </span>
        {authStatus === "checking" ? (
          <p className="text-stone-500 text-sm">Checking sign-in...</p>
        ) : (
          <>
            {authError && <p className="text-sm text-red-600 max-w-sm text-center">{authError}</p>}
            <button
              type="button"
              onClick={() => {
                setAuthError(null);
                void signInWithGoogle().catch((err) => setAuthError(err instanceof Error ? err.message : String(err)));
              }}
              className="rounded-xl text-white px-6 py-3 text-base font-medium hover:opacity-90"
              style={{ backgroundColor: "var(--enso-red)" }}
            >
              Sign in with Google
            </button>
          </>
        )}
      </div>
    );
  }

  // md:w-full is not redundant with md:max-w-5xl md:mx-auto — verified
  // live: mx-auto's auto margins disable this flex item's default
  // stretch-to-fill behavior (CSS flexbox spec: an item with auto
  // cross-axis margins is centered via those margins instead of being
  // stretched), so without an explicit width this collapsed to its
  // content's own shrink-to-fit size (544px on a 1600px-wide desktop, not
  // the intended 1024px cap) rather than filling out to max-width before
  // being capped.
  return (
    <div className="h-full flex flex-col overflow-hidden md:w-full md:max-w-5xl md:mx-auto">
      {/* Mobile layout and scroll fixes batch: reduced from a ~96px row
          (w-16 mark, text-4xl wordmark, inline "Sign out" label) to a
          single ~56px one (h-14) — same mark asset, same wordmark, same
          colors, just smaller, with "Sign out" moved into the ⋮ menu below
          to make room. `shrink-0` (a flex:none sibling of the scrolling
          message list, never vh-sized) is what keeps this row's height
          fixed regardless of keyboard open/close — nothing here reacts to
          the viewport at all, which is the point. */}
      <header className="shrink-0 h-14 flex items-center gap-3 px-4 border-b border-stone-200">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/assets/enso-mark.png" alt="" className="w-8 h-8" />
        <span className="text-[1.0625rem] font-bold tracking-wide" style={{ color: "var(--enso-ink)" }}>
          Enso
        </span>

        {/* Single ml-auto wrapper, not one per button — flexbox only
            honors the FIRST auto margin among siblings to push the whole
            rest of the row right; a second independent ml-auto here would
            fight the first instead of just sitting next to it. */}
        <div className="ml-auto flex items-center gap-1">
          {/*
            Mobile-only entry point to the zodiac sidebar (ZodiacSidebar.tsx
            owns the actual panel). Gated on zodiacAvailable — set by that
            component's onAvailabilityChange — so this button exists ONLY
            once the birthdate gate has unlocked real content, never as a
            tap target that opens an empty/"not available yet" panel.
          */}
          {zodiacAvailable && (
            <button type="button" onClick={() => setMobileSidebarOpen(true)} className="md:hidden shrink-0 w-10 h-10 flex items-center justify-center" title="Open your zodiac sidebar">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/assets/enso-mark.png" alt="Zodiac sidebar" className="w-6 h-6" />
            </button>
          )}
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
              className="w-10 h-10 flex items-center justify-center text-sm text-stone-400 hover:text-stone-600"
            >
              📍
            </button>
          )}

          {/* ⋮ overflow menu: signed-in email (read-only — testers use this
              to confirm which Google account they're on) and Sign out,
              moved here to fit the reduced header height. */}
          <div ref={menuRef} className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((open) => !open)}
              className="w-10 h-10 flex items-center justify-center text-xl leading-none text-stone-500 hover:text-stone-800"
              title="Menu"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              ⋮
            </button>
            {menuOpen && (
              <div role="menu" className="absolute right-0 top-full mt-1 w-56 rounded-lg bg-white border border-stone-200 shadow-lg py-2 z-40">
                <div className="px-3 py-1.5 text-xs text-stone-400 truncate" title={user?.email ?? undefined}>
                  {user?.email ?? "Signed in"}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    void signOut();
                  }}
                  className="w-full text-left px-3 py-1.5 text-sm text-stone-600 hover:bg-stone-50 hover:text-stone-900"
                >
                  Sign out
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="flex-1 flex min-h-0">
        <div className="flex-1 flex flex-col min-h-0 min-w-0">
          {/* Scroll container (listRef) and its content (contentRef) are
              deliberately separate elements — see the refs' own comments
              above for why a single element can't serve both the
              ResizeObserver's "did new content arrive" question and the
              scroll-position bookkeeping at once. This wrapper is the
              positioning context for the jump-to-bottom button, sized to
              exactly the list's own flex-1 allocation so the button sits
              just above the composer regardless of the composer's
              (now variable) height.

              Reported bug 6 (bubbles clipping top/bottom, a stray empty
              box below the last message) was attributed to this structure
              missing min-height:0 at some level of the flex chain, fixed
              by making the levels explicit here. That explanation is
              UNCONFIRMED, not verified — the only check performed was DOM
              measurement in a mocked Playwright harness on desktop
              Chromium, a different evidence class from the real phone and
              real keyboard the bug was originally seen on. If it
              reproduces on a real device, treat this structural
              explanation as wrong, not as "fixed but regressed." */}
          <div className="flex-1 min-h-0 relative">
            <div ref={listRef} className="h-full overflow-y-auto overscroll-contain">
              <div ref={contentRef} className="p-4 flex flex-col gap-3">
                {messages.map((m) => (
                  <div
                    key={m.id}
                    className={`max-w-lg rounded-lg px-4 py-3 text-[1.0625rem] leading-[1.45] whitespace-pre-wrap ${
                      m.role === "user" ? "self-end text-white" : "self-start bg-white border border-stone-200"
                    }`}
                    style={m.role === "user" ? { backgroundColor: "var(--enso-red)", color: "#faf7f2" } : { color: "var(--enso-ink)" }}
                  >
                    {/* Secondary text, scaled proportionally to the 17px
                        body above (0.75rem was proportional to the old
                        16px body — 0.75 * 17/16 ≈ 0.8rem keeps the same
                        relative weight against the new size, not just an
                        unscaled leftover). No explicit leading override:
                        a unitless line-height (leading-[1.45] above) is
                        inherited as the RATIO, not the computed pixel
                        value, so this recomputes correctly against its
                        own smaller font-size automatically. */}
                    {m.filename && <div className="text-[0.8rem] opacity-80 mb-1">Attached: {m.filename}</div>}
                    {m.text}
                  </div>
                ))}
              </div>
            </div>

            {/* Shown only once the user has scrolled up past the pin
                threshold (isPinnedToBottom, app/lib/chatScroll.ts) — history
                is a core use of this app and an incoming reply must not
                yank them back down; this gives them a way back instead. */}
            {showJumpToBottom && (
              <button
                type="button"
                onClick={handleJumpToBottom}
                title="Jump to latest"
                className="absolute bottom-3 right-3 w-10 h-10 rounded-full bg-white border border-stone-300 shadow-md flex items-center justify-center text-stone-600 hover:bg-stone-50"
              >
                ↓
              </button>
            )}
          </div>

          <form
            ref={formRef}
            onSubmit={(e) => {
              e.preventDefault();
              void sendMessage();
            }}
            className="shrink-0 flex flex-col gap-1.5 px-3 py-2 border-t border-stone-200"
            style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}
          >
            {pendingFile && (
              <div className="flex items-center gap-2 text-sm text-stone-600 bg-stone-100 border border-stone-300 rounded-lg px-3 py-1.5 w-fit">
                <span>{pendingFile.name}</span>
                <button type="button" onClick={() => setPendingFile(null)} className="text-stone-400 hover:text-stone-700" title="Remove attachment">
                  ×
                </button>
              </div>
            )}
            {/* items-end (not items-stretch): the attachment/Send buttons
                are fixed ~44px tap targets that stay bottom-aligned as the
                textarea grows (next commit) — they must never stretch to
                match its height or vertically re-center mid-growth. */}
            <div className="flex items-end gap-2">
              <input ref={fileInputRef} type="file" onChange={handleFileChange} className="hidden" id="attachment-input" />
              <label
                htmlFor="attachment-input"
                className="shrink-0 w-11 h-11 flex items-center justify-center cursor-pointer rounded-xl bg-stone-100 border border-stone-300 text-stone-600 hover:bg-stone-200"
                title="Attach a file"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                </svg>
              </label>
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                disabled={sending}
                placeholder={isNarrowScreen ? "Message Enso..." : "Tell Enso what's on your mind... (Enter to send, Shift+Enter for a new line)"}
                rows={1}
                className="flex-1 min-w-0 min-h-11 max-h-[10.619rem] resize-none rounded-xl px-3 py-2.5 text-[1.0625rem] leading-[1.45] bg-white border border-stone-300 focus:outline-none focus:ring-2 focus:ring-stone-300 disabled:opacity-50 overflow-y-auto"
              />
              <button
                type="submit"
                disabled={sending || (!input.trim() && !pendingFile)}
                className="shrink-0 h-11 rounded-xl text-white px-5 text-base font-medium disabled:opacity-50 hover:opacity-90"
                style={{ backgroundColor: "var(--enso-red)" }}
              >
                Send
              </button>
            </div>
          </form>
        </div>

        <ZodiacSidebar
          refreshSignal={sidebarRefreshSignal}
          onAvailabilityChange={setZodiacAvailable}
          mobileOpen={mobileSidebarOpen}
          onMobileClose={() => setMobileSidebarOpen(false)}
        />
      </div>

      {attachmentStatus && (
        <div className="fixed bottom-20 left-4 max-w-sm rounded-lg bg-stone-800 text-white text-xs px-3 py-2 shadow-lg z-10">
          {attachmentStatus.filename}: {attachmentStatus.extractionSucceeded ? "extraction succeeded" : `extraction failed — ${attachmentStatus.extractionError}`}
        </div>
      )}
    </div>
  );
}
