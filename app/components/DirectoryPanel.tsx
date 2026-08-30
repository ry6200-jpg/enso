"use client";

import { useState } from "react";
import { ATTRIBUTE_TYPES, type AttributeType } from "../../src/projections/attributeVocabulary.js";

/** "life_stage" -> "Life stage" — generic so a vocabulary addition needs no matching UI-label edit here. */
function attributeLabel(attribute: AttributeType): string {
  const spaced = attribute.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Admin-only entity view (part 2). This component never fetches on its
 * own — page.tsx already fetched /api/directory once (to decide whether
 * to show the menu item at all) and passes that same response in as
 * `data`, avoiding a second identical computation. The real access
 * control is entirely server-side (requireAdminUserId, a bare 404
 * before any work); this panel being mounted at all already implies the
 * fetch that produced `data` succeeded.
 */

export interface DirectoryBondView {
  otherEntityId: string;
  otherEntityName: string;
  relationshipClass: string;
  direction: "from" | "to";
  withPrimary: boolean;
}

export interface DirectoryEntry {
  entityId: string;
  canonicalName: string;
  nameVariants: string[];
  attributes: Record<AttributeType, string | null>;
  bonds: DirectoryBondView[];
  relationshipClassToPrimary: string | null;
  mentionCount: number;
  firstMentionAt: string | null;
  lastMentionAt: string | null;
  daysSinceLastMention: number | null;
  dormant: boolean;
}

export type DirectoryFillRates = Record<AttributeType, number> & { totalEntities: number };

export interface DirectoryResponse {
  entities: DirectoryEntry[];
  fillRates: DirectoryFillRates;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function EntityRow({ entry }: { entry: DirectoryEntry }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="border border-stone-200 rounded">
      <button type="button" onClick={() => setOpen((o) => !o)} className="w-full text-left px-3 py-2 text-sm flex items-center justify-between hover:bg-stone-50">
        <span className="font-medium text-stone-800">
          {entry.canonicalName}
          {entry.relationshipClassToPrimary && <span className="text-stone-400 font-normal"> — {entry.relationshipClassToPrimary}</span>}
          {entry.dormant && <span className="ml-2 text-xs text-amber-600">dormant</span>}
        </span>
        <span className="text-xs text-stone-400">{entry.mentionCount} mention{entry.mentionCount === 1 ? "" : "s"}</span>
      </button>
      {open && (
        <div className="px-3 pb-3 text-sm text-stone-600 space-y-2">
          {entry.nameVariants.length > 0 && <div>Also known as: {entry.nameVariants.join(", ")}</div>}
          <div>{ATTRIBUTE_TYPES.map((attribute) => `${attributeLabel(attribute)}: ${entry.attributes[attribute] ?? "—"}`).join(" · ")}</div>
          <div>
            First mentioned: {formatDate(entry.firstMentionAt)} · Last mentioned: {formatDate(entry.lastMentionAt)}
            {entry.daysSinceLastMention !== null && ` (${Math.floor(entry.daysSinceLastMention)} days ago)`}
          </div>
          {entry.bonds.length > 0 && (
            <div>
              Connected to:
              <ul className="ml-3 list-disc">
                {entry.bonds.map((b, i) => (
                  <li key={i}>
                    {b.otherEntityName} ({b.relationshipClass})
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

export default function DirectoryPanel({ data, onClose }: { data: DirectoryResponse; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/30 flex items-start justify-center overflow-y-auto py-8 px-4">
      <div className="bg-white rounded-lg max-w-2xl w-full shadow-xl">
        <div className="flex items-center justify-between px-5 py-3 border-b border-stone-200">
          <h2 className="font-semibold text-stone-800">Entity directory</h2>
          <button type="button" onClick={onClose} className="text-stone-400 hover:text-stone-700 text-xl leading-none" title="Close">
            ×
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="text-xs text-stone-400">
            {data.fillRates.totalEntities} entities. Fill rate — {ATTRIBUTE_TYPES.map((attribute) => `${attributeLabel(attribute).toLowerCase()}: ${(data.fillRates[attribute] * 100).toFixed(0)}%`).join(", ")}
          </div>

          {data.entities.length === 0 && <p className="text-sm text-stone-500">No entities on record yet.</p>}

          <ul className="space-y-1">
            {data.entities.map((entry) => (
              <EntityRow key={entry.entityId} entry={entry} />
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
