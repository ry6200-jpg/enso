"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

/**
 * UI fixes batch: this sidebar is now also where Horoscope and People are
 * reached (item 9 — the Chat/Horoscope/People tab row was removed
 * entirely; see app/page.tsx and the design note there). The nav links
 * below are unconditional — reaching Horoscope or People was never meant
 * to depend on having a birthdate on record, only the zodiac content
 * itself is gated on that (item 10, unchanged behavior).
 *
 * Order: Western zodiac on top, Chinese below — reversed from the
 * original design per live feedback; EN-031 in the spec is updated to
 * match.
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

function SidebarNav() {
  return (
    <nav className="flex gap-4 text-sm pb-4 mb-1 border-b border-stone-200">
      <Link href="/horoscope" className="text-stone-500 hover:text-stone-800">
        Horoscope
      </Link>
      <Link href="/people" className="text-stone-500 hover:text-stone-800">
        People
      </Link>
    </nav>
  );
}

export default function ZodiacSidebar() {
  const [data, setData] = useState<ZodiacSidebarData | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/zodiac-sidebar")
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
  }, []);

  return (
    <aside className="w-72 shrink-0 border-l border-stone-200 p-4 flex flex-col gap-5 overflow-y-auto">
      <SidebarNav />
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
