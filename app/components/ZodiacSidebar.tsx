"use client";

import { useEffect, useState } from "react";

/** EN-031: Chinese zodiac on top, Western below, both derived from the user's stored birthdate, using the approved 24-icon set (public/assets/). */

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

  if (!data) return <aside className="w-72 shrink-0 border-l border-stone-200 p-4 text-sm text-stone-400">Loading...</aside>;

  if (!data.available) {
    return <aside className="w-72 shrink-0 border-l border-stone-200 p-4 text-sm text-stone-400">Mention your birthdate to Enso in chat to unlock your zodiac sidebar.</aside>;
  }

  return (
    <aside className="w-72 shrink-0 border-l border-stone-200 p-4 flex flex-col gap-5 overflow-y-auto">
      {data.chinese && <ZodiacSection {...data.chinese} />}
      {data.western && <ZodiacSection {...data.western} />}
    </aside>
  );
}
