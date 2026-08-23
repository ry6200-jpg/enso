"use client";

import { useEffect, useState } from "react";
import { authFetch } from "../lib/firebaseClient";

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
 */

interface ZodiacSidebarData {
  available: boolean;
  date?: string;
  chinese?: { sign: string; iconUrl: string; reflection: string };
  western?: { sign: string; iconUrl: string; reflection: string };
}

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

export default function ZodiacSidebar({ refreshSignal = 0 }: { refreshSignal?: number }) {
  const [data, setData] = useState<ZodiacSidebarData | null>(null);

  useEffect(() => {
    let cancelled = false;
    authFetch("/api/zodiac-sidebar")
      .then((r) => r.json())
      .then((json: ZodiacSidebarData) => {
        if (!cancelled) setData(json);
      })
      .catch(() => {
        if (!cancelled) setData({ available: false });
      });
    return () => {
      cancelled = true;
    };
  }, [refreshSignal]);

  return (
    <aside className="w-72 shrink-0 border-l border-stone-200 p-4 flex flex-col gap-5 overflow-y-auto">
      {!data && <p className="text-sm text-stone-400">Loading...</p>}
      {data && !data.available && <p className="text-sm text-stone-400">Mention your birthdate to Enso in chat to unlock your zodiac sidebar.</p>}
      {data?.available && (
        <>
          {data.western && <ZodiacSection {...data.western} />}
          {data.chinese && <ZodiacSection {...data.chinese} />}
        </>
      )}
    </aside>
  );
}
