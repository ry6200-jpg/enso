import type { ProjectionsDb, EntityRow, SocialBondRow, StructuralAtomRow } from "../../projections/db.js";
import { primaryEntityId } from "../../projections/rebuild.js";
import type { ReportWindow } from "../reportWindows.js";

/**
 * Report page, Stage A (methodology Section 2.2). "The part of the
 * report no journaling app can compute, because it requires the entity
 * graph Enso already maintains" — network and temporal markers are exact
 * at any message length, so these are the substance of the page (unlike
 * the word-class rates in wordClassMarkers.ts, which are noisy at this
 * corpus's ~10-words-per-message rhythm and are displayed last).
 *
 * Deliberately NOT built this pass, stated plainly rather than silently
 * dropped: "bridging positions (Burt's structural-holes framing)" from
 * the methodology's own list. Computing it honestly needs alter-to-alter
 * edges (two of the owner's people connected to each other, not just to
 * the owner), which this schema CAN represent (social_bonds/
 * structural_atoms aren't restricted to primary-user pairs) but which
 * this corpus has essentially none of recorded yet — an articulation-
 * point algorithm over a graph with almost no alter-alter edges would
 * either find nothing or overfit noise. Density (below) is the simpler,
 * well-defined piece of the same idea and is built; bridging is a real
 * follow-up once there's enough alter-alter data for it to mean anything.
 */

/** Days since last mention beyond which an established tie is flagged dormant — a named default, not a literature-derived number (the methodology names dormancy onset as computable but doesn't give a threshold). */
export const DORMANCY_THRESHOLD_DAYS = 21;

function isEstablished(projections: ProjectionsDb, userId: string, entityId: string): boolean {
  const primary = primaryEntityId(userId);
  const connectsToPrimary = (a: string, b: string) => (a === entityId && b === primary) || (a === primary && b === entityId);
  return (
    projections.listStructuralAtoms(userId).some((atom) => connectsToPrimary(atom.from_entity_id, atom.to_entity_id) && atom.interval_end === null) ||
    projections.listSocialBonds(userId).some((bond) => connectsToPrimary(bond.from_entity_id, bond.to_entity_id) && bond.interval_end === null)
  );
}

function sourceIds(entity: EntityRow): string[] {
  return (JSON.parse(entity.source_event_ids) as string[]).slice().sort();
}

export interface WindowNetworkResult {
  windowIndex: number;
  /** Distinct established entities mentioned at least once in this window. */
  activeTieCount: number;
  /** Established entities whose FIRST-EVER mention falls in this window. */
  newEntityCount: number;
  /** |symmetric difference of active-entity sets| / |union|, vs. the immediately preceding window — null for the first window (no prior to compare). */
  turnover: number | null;
  /** Herfindahl-Hirschman Index over this window's mention distribution across entities — 1/n (spread evenly) to 1 (all mentions on one entity). Null when the window has zero entity mentions. */
  mentionConcentrationHhi: number | null;
}

export interface DormancyResult {
  entityId: string;
  name: string;
  lastMentionAt: string;
  daysSinceLastMention: number;
  dormant: boolean;
}

export interface TieCompositionEntry {
  relationshipClass: string;
  count: number;
}

export interface NetworkMarkers {
  perWindow: WindowNetworkResult[];
  dormancy: DormancyResult[];
  tieComposition: TieCompositionEntry[];
  /** Actual alter-to-alter edges / possible edges among the owner's established ties — null when fewer than 2 alters exist (no possible edge to measure). */
  alterDensity: number | null;
}

function messageIdsInWindow(window: ReportWindow): Set<string> {
  return new Set(window.messages.map((m) => m.id));
}

function entityMentionedInWindow(entity: EntityRow, windowMessageIds: Set<string>): boolean {
  return sourceIds(entity).some((id) => windowMessageIds.has(id));
}

function hhi(counts: number[]): number | null {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  return counts.reduce((sum, c) => sum + (c / total) ** 2, 0);
}

/**
 * `recordedAtByMessageId` is caller-supplied (built from the event log,
 * the same `id -> recordedAt` pattern established elsewhere in this
 * codebase — e.g. entityInterest.ts's turnIndexByMessageId) rather than
 * decoded from the ULIDs themselves: a ULID's embedded timestamp is a
 * generation-time artifact, not the field of record, and the event's own
 * `recorded_at` is what every other part of this project treats as the
 * actual time something happened.
 */
export function computeNetworkMarkers(
  projections: ProjectionsDb,
  userId: string,
  windows: ReportWindow[],
  recordedAtByMessageId: Map<string, string>,
  nowIso: string
): NetworkMarkers {
  const allEntities = projections.listEntities(userId);
  const established = allEntities.filter((e) => isEstablished(projections, userId, e.id));

  let previousActiveIds: Set<string> | null = null;
  const perWindow: WindowNetworkResult[] = windows.map((window) => {
    const windowMessageIds = messageIdsInWindow(window);
    const activeInWindow = established.filter((e) => entityMentionedInWindow(e, windowMessageIds));
    const activeIds = new Set(activeInWindow.map((e) => e.id));

    const newEntityCount = established.filter((e) => {
      const ids = sourceIds(e);
      return ids.length > 0 && windowMessageIds.has(ids[0]!);
    }).length;

    let turnover: number | null = null;
    if (previousActiveIds !== null) {
      const union = new Set([...previousActiveIds, ...activeIds]);
      const symmetricDiff = [...union].filter((id) => previousActiveIds!.has(id) !== activeIds.has(id));
      turnover = union.size > 0 ? symmetricDiff.length / union.size : 0;
    }
    previousActiveIds = activeIds;

    const mentionCounts = activeInWindow.map((e) => sourceIds(e).filter((id) => windowMessageIds.has(id)).length);

    return {
      windowIndex: window.index,
      activeTieCount: activeInWindow.length,
      newEntityCount,
      turnover,
      mentionConcentrationHhi: hhi(mentionCounts)
    };
  });

  const now = new Date(nowIso).getTime();
  const dormancy: DormancyResult[] = established
    .map((e) => {
      const ids = sourceIds(e);
      const lastId = ids[ids.length - 1];
      const lastMentionAt = lastId ? recordedAtByMessageId.get(lastId) : undefined;
      if (!lastMentionAt) return null; // no resolvable mention timestamp — excluded rather than guessed
      const daysSinceLastMention = (now - new Date(lastMentionAt).getTime()) / (24 * 60 * 60 * 1000);
      return { entityId: e.id, name: e.name, lastMentionAt, daysSinceLastMention, dormant: daysSinceLastMention >= DORMANCY_THRESHOLD_DAYS };
    })
    .filter((d): d is DormancyResult => d !== null);

  const bondCounts = new Map<string, number>();
  for (const bond of projections.listSocialBonds(userId)) {
    if (bond.interval_end !== null) continue;
    bondCounts.set(bond.type, (bondCounts.get(bond.type) ?? 0) + 1);
  }
  for (const atom of projections.listStructuralAtoms(userId)) {
    if (atom.interval_end !== null) continue;
    bondCounts.set(atom.type, (bondCounts.get(atom.type) ?? 0) + 1);
  }
  const tieComposition: TieCompositionEntry[] = [...bondCounts.entries()].map(([relationshipClass, count]) => ({ relationshipClass, count }));

  // Alter-to-alter density: edges where NEITHER side is the primary user's own synthetic id
  // (primaryEntityId never appears as a row in `entities`, so `alterIds` — built from established
  // entities only — already excludes it; a bond/atom touching primary simply never matches both sides).
  const alterIds = new Set(established.map((e) => e.id));
  const alterOnlyPairs = new Set<string>();
  const countEdge = (a: string, b: string) => {
    if (a === b || !alterIds.has(a) || !alterIds.has(b)) return;
    alterOnlyPairs.add([a, b].sort().join(":"));
  };
  for (const bond of projections.listSocialBonds(userId)) if (bond.interval_end === null) countEdge(bond.from_entity_id, bond.to_entity_id);
  for (const atom of projections.listStructuralAtoms(userId)) if (atom.interval_end === null) countEdge(atom.from_entity_id, atom.to_entity_id);
  const n = established.length;
  const possiblePairs = (n * (n - 1)) / 2;
  const alterDensity = possiblePairs > 0 ? alterOnlyPairs.size / possiblePairs : null;

  return { perWindow, dormancy, tieComposition, alterDensity };
}
