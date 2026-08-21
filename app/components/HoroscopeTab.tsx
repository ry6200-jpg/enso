"use client";

import { useEffect, useState } from "react";

/** EN-032: the one exception to the no-tabs UI shell (EN-036). Two sections: Daily Zodiac Compatibility (the user's own signs) and a Synastry Chart against a chosen entity. */

interface DailyHoroscope {
  available: boolean;
  chineseSign?: string;
  westernSign?: string;
  reading?: string;
}

interface Person {
  entityId: string;
  name: string;
}

interface SynastryResult {
  available: boolean;
  reason?: string;
  reading?: string;
}

export default function HoroscopeTab() {
  const [daily, setDaily] = useState<DailyHoroscope | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [synastry, setSynastry] = useState<SynastryResult | null>(null);
  const [loadingSynastry, setLoadingSynastry] = useState(false);

  useEffect(() => {
    fetch("/api/horoscope")
      .then((r) => r.json())
      .then(setDaily)
      .catch(() => setDaily({ available: false }));
    fetch("/api/people")
      .then((r) => r.json())
      .then((json: { people: Person[] }) => {
        setPeople(json.people);
        if (json.people.length > 0) setSelectedId(json.people[0]!.entityId);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    setLoadingSynastry(true);
    fetch(`/api/horoscope/synastry?entityId=${encodeURIComponent(selectedId)}`)
      .then((r) => r.json())
      .then((json: SynastryResult) => {
        if (!cancelled) setSynastry(json);
      })
      .catch(() => {
        if (!cancelled) setSynastry({ available: false, reason: "something went wrong" });
      })
      .finally(() => {
        if (!cancelled) setLoadingSynastry(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  return (
    <div className="flex-1 overflow-y-auto p-6 max-w-2xl mx-auto flex flex-col gap-8">
      <section>
        <h2 className="text-lg font-serif mb-2">Daily Zodiac Compatibility</h2>
        {!daily && <p className="text-sm text-stone-400">Loading...</p>}
        {daily && !daily.available && <p className="text-sm text-stone-400">Mention your birthdate to Enso in chat to unlock this.</p>}
        {daily?.available && (
          <p className="text-sm leading-relaxed">
            <span className="text-stone-500">
              {daily.westernSign} · {daily.chineseSign}
            </span>{" "}
            — {daily.reading}
          </p>
        )}
      </section>

      <section>
        <h2 className="text-lg font-serif mb-2">Synastry Chart</h2>
        {people.length === 0 && <p className="text-sm text-stone-400">No one on record yet — tell Enso about someone first.</p>}
        {people.length > 0 && (
          <select className="border border-stone-300 rounded px-2 py-1 text-sm mb-3" value={selectedId} onChange={(e) => setSelectedId(e.target.value)}>
            {people.map((p) => (
              <option key={p.entityId} value={p.entityId}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        {loadingSynastry && <p className="text-sm text-stone-400">Loading...</p>}
        {!loadingSynastry && synastry && !synastry.available && <p className="text-sm text-stone-400">{synastry.reason}</p>}
        {!loadingSynastry && synastry?.available && <p className="text-sm leading-relaxed">{synastry.reading}</p>}
      </section>
    </div>
  );
}
