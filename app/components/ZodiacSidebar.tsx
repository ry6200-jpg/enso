"use client";

import { useEffect, useState } from "react";
import { authFetch } from "../lib/firebaseClient";
import { resolveZodiacSidebarResponse, type ZodiacSidebarData } from "../lib/zodiacSidebarFetch";
import { runSequenced } from "../lib/pageLoadReadQueue";

/**
 * Batch 2, item 6: the standalone /horoscope and /people pages (and the
 * links to them added in the previous batch) were removed entirely — this
 * sidebar goes back to being zodiac-summary content ONLY. Nothing about
 * the zodiac data or its fetch logic changed; the underlying entity-
 * tracking pipeline (extraction, circle-back, /api/people) keeps running
 * in the background regardless of whether any page displays it.
 *
 * Order: Western zodiac on top, Chinese below — reversed from the
 * original design per live feedback; EN-031 in the spec is updated to
 * match.
 *
 * Item 7 (one of the two root causes — the other was extraction never
 * producing a birthdate attribute at all, fixed separately in
 * src/providers/taxonomySchema.ts): this only ever fetched once, on
 * mount. Establishing a birthdate mid-session, without reloading the
 * page, would never unlock the sidebar even with extraction fixed —
 * nothing told it to look again. refreshSignal (bumped by the parent
 * after every chat turn) re-runs the fetch effect.
 *
 * Mobile layout fix batch: THE structural bug on phones was this component
 * — `w-72 shrink-0` inside the page's flex row reserves 288px unconditionally,
 * with no breakpoint that ever removed it, so a 375px-wide phone got a
 * chat column plus a 288px sidebar it had no way to actually see, and the
 * whole page scrolled sideways to prove it. The fix is structural, not an
 * `overflow-hidden` patch over that width still being reserved: below `md`
 * this component renders NOTHING inline — the desktop `<aside>` is
 * `hidden md:flex`, so it occupies zero width on a phone, full stop. In its
 * place, a small ensō-mark button in the page header (app/page.tsx) opens
 * this same content as an off-canvas panel — `onAvailabilityChange` is how
 * the header knows whether that button should exist at all: per the
 * standing rule, it must appear ONLY once the birthdate gate has actually
 * unlocked real content, never as a tap target that opens an empty/"not
 * yet available" panel.
 */

function ZodiacSection({ sign, iconUrl, reflection }: { sign: string; iconUrl: string; reflection: string }) {
  return (
    <div className="flex gap-3 items-start">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={iconUrl} alt={sign} className="w-12 h-12 shrink-0" />
      <div className="min-w-0">
        <div className="font-medium text-sm">{sign}</div>
        <p className="text-sm text-stone-600 leading-snug">{reflection}</p>
      </div>
    </div>
  );
}

interface ZodiacSidebarProps {
  /**
   * R71: the signed-in uid, so this component's own mount-time read can be
   * sequenced against the page's other mount-time reads (history,
   * directory) at the same per-user storage lock — see
   * pageLoadReadQueue.ts. null before a user is resolved; the fetch below
   * is a no-op until a real uid is present, same guard every other
   * mount-time read in this app already uses.
   */
  uid: string | null;
  refreshSignal?: number;
  /** Fires whenever availability changes — the header's mobile-panel trigger only ever renders while this is true (see this file's header comment). */
  onAvailabilityChange?: (available: boolean) => void;
  /** Mobile off-canvas panel state, owned by the parent (the trigger button lives in the header, not in this component). Irrelevant at md+, where the inline aside is always in flow. */
  mobileOpen?: boolean;
  onMobileClose?: () => void;
}

export default function ZodiacSidebar({ uid, refreshSignal = 0, onAvailabilityChange, mobileOpen = false, onMobileClose }: ZodiacSidebarProps) {
  const [data, setData] = useState<ZodiacSidebarData | null>(null);

  useEffect(() => {
    if (!uid) return;
    let cancelled = false;
    // Stale-tab investigation fix: resolveZodiacSidebarResponse checks
    // `ok` before parsing, so an auth failure (401/403) rejects into the
    // .catch() below instead of its JSON error body getting parsed and
    // cast straight to ZodiacSidebarData — see that function's own
    // comment for why the old `.then((r) => r.json())` made a real
    // failure invisible, rendering as the same message a genuine empty
    // state shows.
    //
    // R71: sequenced against this uid's other mount-time reads (history,
    // directory) so none of them contend at the per-user storage read
    // lock at the same moment — see pageLoadReadQueue.ts.
    runSequenced(uid, () => authFetch("/api/zodiac-sidebar"))
      .then(resolveZodiacSidebarResponse)
      .then((json) => {
        if (!cancelled) setData(json);
      })
      .catch(() => {
        if (!cancelled) setData({ available: false });
      });
    return () => {
      cancelled = true;
    };
  }, [uid, refreshSignal]);

  useEffect(() => {
    onAvailabilityChange?.(data?.available ?? false);
    // onAvailabilityChange is a plain state setter from the parent (setZodiacAvailable) — stable across renders, deliberately not in the dependency array so this fires purely off data changing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const content = (
    <>
      {!data && <p className="text-sm text-stone-400">Loading...</p>}
      {data && !data.available && <p className="text-sm text-stone-400">Mention your birthdate to Enso in chat to unlock your zodiac sidebar.</p>}
      {data?.available && (
        <>
          {data.western && <ZodiacSection {...data.western} />}
          {data.chinese && <ZodiacSection {...data.chinese} />}
        </>
      )}
    </>
  );

  return (
    <>
      {/* Desktop: an ordinary flex sibling, in flow, always present at md+. */}
      <aside className="hidden md:flex w-72 shrink-0 border-l border-stone-200 p-4 flex-col gap-5 overflow-y-auto">{content}</aside>

      {/* Mobile: an off-canvas panel — out of flow (fixed), so it never
          contributes to page width regardless of open/closed state, unlike
          the bug this batch fixed. Rendered (not conditionally mounted) even
          while closed so the slide transition has something to animate from;
          pointer-events-none + aria-hidden keep it fully inert when closed.
          `overflow-hidden` here is standard off-canvas-drawer practice —
          clip the slid-out panel to the viewport — not a patch over the
          width-reservation bug this batch fixed elsewhere: that bug was an
          element occupying real IN-FLOW flex width unconditionally; this is
          an out-of-flow, deliberately-offscreen element that still needs
          its own container to define where "offscreen" ends. */}
      <div className={`md:hidden fixed inset-0 z-30 overflow-hidden ${mobileOpen ? "" : "pointer-events-none"}`} aria-hidden={!mobileOpen}>
        <div
          className={`absolute inset-0 bg-black/30 transition-opacity duration-200 ${mobileOpen ? "opacity-100" : "opacity-0"}`}
          onClick={onMobileClose}
        />
        <aside
          className="absolute right-0 top-0 h-full w-72 max-w-[85vw] bg-[var(--enso-paper)] border-l border-stone-200 p-4 flex flex-col gap-5 overflow-y-auto shadow-xl transition-transform duration-200"
          // Plain inline `transform`, not Tailwind's `translate-x-*`
          // utilities: verified live that Tailwind v4's translate utilities
          // compose through a separate CSS `translate` property built from
          // `@property`-registered custom variables (--tw-translate-x/-y),
          // and in real testing here `--tw-translate-x` resolved correctly
          // while the browser's actual rendered `transform` still computed
          // to `none` — the composition silently didn't reach paint. A
          // direct `transform` is the classic, single-property mechanism
          // with no such composition step to fail.
          style={{ paddingTop: "max(1rem, env(safe-area-inset-top))", transform: mobileOpen ? "translateX(0)" : "translateX(100%)" }}
        >
          <button type="button" onClick={onMobileClose} className="self-end text-stone-400 hover:text-stone-600 text-sm" title="Close">
            Close ✕
          </button>
          {content}
        </aside>
      </div>
    </>
  );
}
