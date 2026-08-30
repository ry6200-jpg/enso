import type { EventRecord } from "../events/schema.js";

/**
 * Co-reference merge fold (EN-101/Bug fix 2 of 2), following
 * computeEclipsedEventIds' own precedent exactly (src/attachments/
 * uploadDeletion.ts): a pre-pass over the FULL event array, run once
 * before rebuild's main chronological loop, so a confirmation recorded
 * anywhere in the log — including one that appears in the log AFTER the
 * mentions it links — can still affect how those earlier mentions resolve
 * on THIS replay. No row-moving, no backfill: the main loop consults this
 * map at the exact moment either side's stable-key event is reached and
 * creates/returns the canonical identity directly, so the non-canonical
 * entity is simply never created in a replay that includes the
 * confirmation.
 *
 * Both fact_confirmed (the co-reference confirmation) and fact_corrected
 * (a retraction targeting that confirmation's own event ULID, EN-055) are
 * read here — never the two EXISTING post-loop handlers in rebuild.ts,
 * which run after the main loop has already finished and would be far too
 * late for a fold that needs entities to be "born correct." Both payload
 * kinds are discriminated by an explicit `kind` field, checked before
 * anything else — an absent/different kind falls through to the ordinary,
 * unrelated fact_confirmed/fact_corrected handling in rebuild.ts,
 * untouched by this module.
 */

export interface CoReferenceMergeInfo {
  /** The role-word placeholder's own earliest-provenance-event ULID (never a projection entity id — those are reassigned every rebuild, EN-054). */
  placeholderStableKey: string;
  /** The real-named entity's own earliest-provenance-event ULID. */
  realStableKey: string;
  /**
   * The exact raw name strings the merge applies to. Necessary, not
   * cosmetic: a stable-key event is a MESSAGE event id, and other,
   * unrelated names are routinely mentioned in that same message (the
   * anchor itself, almost always — "her husband is not well" mentions
   * both "husband" and "Annissa" in one message). Matching on event id
   * alone would misfire on every co-mentioned name that happens to share
   * a stable-key event with the placeholder or real side; matching on the
   * specific name too (case/whitespace-insensitively, checked by the
   * caller) is what keeps the merge scoped to the two names it's actually
   * about.
   */
  placeholderName: string;
  realName: string;
  /** The canonical name to create the merged entity under — always the real name (DECIDED: a real name beats a role-word placeholder outright). */
  canonicalName: string;
  /**
   * Alias-suppression fix: whether the LOSING side's exact name string
   * should be kept out of the alias index going forward. True for the
   * role-word flow (the only flow that has ever run) — a role word like
   * "husband" must stay free to resolve to some other, unrelated anchor
   * elsewhere in the account, so it is deliberately never registered.
   * False is for a future real-name-vs-real-name merge, where the losing
   * side IS a specific person's name, and leaving it unaliased would
   * silently re-split the merge on that name's next independent mention
   * (it would fail to resolve and spin up a fresh duplicate entity).
   * Read directly from the fact_confirmed payload — never recomputed at
   * replay time, since only the two name strings survive by then, not
   * either entity's original name_kind.
   */
  aliasSuppressed: boolean;
}

interface StoredCoReferenceConfirmation {
  confirmationEventId: string;
  placeholderStableKey: string;
  placeholderName: string;
  realStableKey: string;
  realName: string;
  canonicalName: string;
  aliasSuppressed: boolean;
}

/**
 * Returns a map from EITHER side's stable-key event ULID to the pairing's
 * merge info — a lookup by the placeholder's stable key or the real
 * entity's stable key both land on the same CoReferenceMergeInfo. Empty
 * whenever no co-reference confirmations exist in the log, same cheap
 * early-return shape as computeEclipsedEventIds.
 */
export function computeCoReferenceMerges(events: EventRecord[]): Map<string, CoReferenceMergeInfo> {
  const confirmations = new Map<string, StoredCoReferenceConfirmation>();
  for (const event of events) {
    if (event.type !== "fact_confirmed") continue;
    const payload = event.payload as Record<string, unknown>;
    if (payload.kind !== "coReference") continue;
    const placeholderStableKey = payload.placeholderStableKey;
    const placeholderName = payload.placeholderName;
    const realStableKey = payload.realStableKey;
    const realName = payload.realName;
    if (
      typeof placeholderStableKey !== "string" ||
      typeof placeholderName !== "string" ||
      typeof realStableKey !== "string" ||
      typeof realName !== "string"
    )
      continue;
    // Absent on any confirmation recorded before this field existed —
    // every one of them ran the role-word flow, the only flow that has
    // ever produced a coReference confirmation, so defaulting to
    // suppressed (true) reproduces exactly what already happened rather
    // than changing behavior for historical data on replay.
    const aliasSuppressed = typeof payload.aliasSuppressed === "boolean" ? payload.aliasSuppressed : true;
    confirmations.set(event.id, { confirmationEventId: event.id, placeholderStableKey, placeholderName, realStableKey, realName, canonicalName: realName, aliasSuppressed });
  }
  if (confirmations.size === 0) return new Map();

  const retractedConfirmationIds = new Set<string>();
  for (const event of events) {
    if (event.type !== "fact_corrected") continue;
    const payload = event.payload as Record<string, unknown>;
    if (payload.kind !== "coReferenceRetraction") continue;
    if (typeof payload.targetEventId === "string") retractedConfirmationIds.add(payload.targetEventId);
  }

  const merges = new Map<string, CoReferenceMergeInfo>();
  for (const c of confirmations.values()) {
    if (retractedConfirmationIds.has(c.confirmationEventId)) continue;
    const info: CoReferenceMergeInfo = {
      placeholderStableKey: c.placeholderStableKey,
      realStableKey: c.realStableKey,
      placeholderName: c.placeholderName,
      realName: c.realName,
      canonicalName: c.canonicalName,
      aliasSuppressed: c.aliasSuppressed
    };
    merges.set(c.placeholderStableKey, info);
    merges.set(c.realStableKey, info);
  }
  return merges;
}
