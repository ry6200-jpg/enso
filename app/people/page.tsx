"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface ProvenancedFact {
  value: string;
  toldOn: string | null;
}

interface PersonView {
  entityId: string;
  name: string;
  confirmed: boolean;
  attributes: { attribute: string; facts: ProvenancedFact[] }[];
  relationships: { type: string; direction: string; basis: string; toldOn: string | null }[];
}

function formatToldOn(iso: string | null): string {
  if (!iso) return "source unclear";
  return `you told me this on ${new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}`;
}

/**
 * Phase 7 Part 2: what Enso holds, with every value traceable to its
 * source — the UI shows what the chat voice never narrates (per
 * MEMORY_HONESTY_INSTRUCTION's "never expose mechanics" rule, which
 * governs the chat voice, not this dedicated surface). Not a tab (EN-036
 * reserves the one tab exception for Horoscope) — a separate route,
 * reachable via the nav link in app/page.tsx.
 *
 * Deletion: EN-065's detailed one-click deletion flow is specifically an
 * ATTACHMENT deletion flow (Section 7) — there is no separately-spec'd
 * entity/fact-level deletion UX in the spec to build against here. Rather
 * than silently omit a delete affordance, it's stubbed visibly below:
 * present, disabled, explaining why.
 */
export default function PeoplePage() {
  const [people, setPeople] = useState<PersonView[] | null>(null);

  useEffect(() => {
    fetch("/api/people")
      .then((r) => r.json())
      .then((json: { people: PersonView[] }) => setPeople(json.people))
      .catch(() => setPeople([]));
  }, []);

  return (
    <div className="h-full flex flex-col">
      <header className="shrink-0 flex items-center gap-4 px-4 py-2 border-b border-stone-200">
        <Link href="/" className="text-sm text-stone-500">
          ← Chat
        </Link>
        <span className="font-serif text-lg">People</span>
      </header>

      <div className="flex-1 overflow-y-auto p-4 max-w-2xl mx-auto w-full flex flex-col gap-4">
        {people === null && <p className="text-sm text-stone-400">Loading...</p>}
        {people?.length === 0 && <p className="text-sm text-stone-400">No one on record yet.</p>}
        {people?.map((p) => (
          <div key={p.entityId} className="border border-stone-200 rounded-lg p-4">
            <div className="flex items-center justify-between">
              <h3 className="font-medium">{p.name}</h3>
              <button disabled title="Fact-level deletion isn't specified for this surface yet — EN-065's one-click deletion flow is for attachments specifically. Deleting an upload already removes its sole-provenance facts." className="text-xs text-stone-400 border border-stone-200 rounded px-2 py-1 cursor-not-allowed">
                Delete (not yet available here)
              </button>
            </div>

            {p.relationships.length > 0 && (
              <ul className="mt-2 text-sm text-stone-600">
                {p.relationships.map((r, i) => (
                  <li key={i}>
                    {r.type.replace(/_/g, " ")} ({r.basis}) — {formatToldOn(r.toldOn)}
                  </li>
                ))}
              </ul>
            )}

            {p.attributes.map((a) => (
              <div key={a.attribute} className="mt-2">
                <div className="text-xs uppercase tracking-wide text-stone-400">{a.attribute}</div>
                {a.facts.map((f, i) => (
                  <div key={i} className="text-sm">
                    {f.value} <span className="text-stone-400">— {formatToldOn(f.toldOn)}</span>
                  </div>
                ))}
              </div>
            ))}

            {p.relationships.length === 0 && p.attributes.length === 0 && <p className="mt-2 text-sm text-stone-400">Nothing established yet — just a name.</p>}
          </div>
        ))}
      </div>
    </div>
  );
}
