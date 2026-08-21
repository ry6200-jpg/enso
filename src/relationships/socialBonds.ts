import { newId } from "../ids.js";
import type { ProjectionsDb, SocialBondRow } from "../projections/db.js";

/**
 * Class B social bonds (EN-013): typed intervals, not graph edges.
 * Accretion, not transition — multiple bond types coexist openly on the
 * same pair. `peer_of` is not in the type vocabulary (rejected as too
 * vague to traverse or type); `romantic` never graduates to structural —
 * only an explicit spouse_of atom generates in-laws.
 *
 * The open-inferred/close-stated asymmetry is enforced structurally, not
 * just by convention: `openBond` accepts either basis, but `closeBond` is
 * the ONLY function in this module that can set interval_end, and it does
 * not take a basis parameter at all — every call to it is, definitionally,
 * a stated closure. There is no scheduled job, no idle-timeout check, and
 * no code path anywhere that closes a bond because it simply hasn't been
 * mentioned in a while. Silence cannot close an interval because nothing
 * in this codebase reacts to silence.
 */

function canonicalPair(a: string, b: string): [string, string] {
  return a <= b ? [a, b] : [b, a];
}

export interface OpenBondInput {
  type: SocialBondRow["type"];
  fromEntityId: string;
  toEntityId: string;
  qualifier?: string | null;
  openedBasis: "inferred" | "stated";
  intervalStart?: string | null;
  sourceEventIds: string[];
}

/**
 * Opens a bond interval. If an OPEN interval of the same type already
 * exists for this pair, returns it unchanged rather than creating a
 * duplicate (re-inferring "coworker Priya" every time she's mentioned
 * should not spawn a new colleague interval each time).
 */
export function openBond(projections: ProjectionsDb, userId: string, input: OpenBondInput): SocialBondRow {
  const [from, to] = input.type === "mentor_of" ? [input.fromEntityId, input.toEntityId] : canonicalPair(input.fromEntityId, input.toEntityId);

  const existingOpen = projections
    .listSocialBonds(userId)
    .find((b) => b.type === input.type && b.from_entity_id === from && b.to_entity_id === to && b.interval_end === null);
  if (existingOpen) return existingOpen;

  const row: SocialBondRow = {
    id: newId(),
    user_id: userId,
    type: input.type,
    from_entity_id: from,
    to_entity_id: to,
    qualifier: input.qualifier ?? null,
    opened_basis: input.openedBasis,
    interval_start: input.intervalStart ?? null,
    interval_end: null,
    source_event_ids: JSON.stringify([...new Set(input.sourceEventIds)].sort()),
    created_at: new Date().toISOString()
  };
  projections.insertSocialBond(row);
  return row;
}

/**
 * Closes a bond interval. Takes no basis parameter — every call is a
 * stated closure by construction (EN-013: "closure is authoritative
 * erasure; the pipeline never infers it"). Callers must have a
 * `sourceEventId` for the statement that closed it; there is no variant of
 * this function that accepts "time since last mention" or any other
 * silence-based signal.
 */
export function closeBond(projections: ProjectionsDb, bondId: string, closedAtDate: string, sourceEventId: string): void {
  const bond = projections.getSocialBondById(bondId);
  if (!bond) {
    throw new Error(`No social bond with id ${bondId}`);
  }
  if (bond.interval_end !== null) {
    return; // already closed — closing twice is a no-op, not an error
  }
  projections.closeSocialBond(bondId, closedAtDate, sourceEventId);
}

export function isBondOpen(bond: SocialBondRow, asOfDate?: string): boolean {
  if (bond.interval_end === null) return true;
  if (!asOfDate) return false;
  return bond.interval_end > asOfDate;
}

export function findBondsBetween(projections: ProjectionsDb, userId: string, entityIdA: string, entityIdB: string): SocialBondRow[] {
  const [from, to] = canonicalPair(entityIdA, entityIdB);
  return projections
    .listSocialBonds(userId)
    .filter(
      (b) =>
        (b.from_entity_id === from && b.to_entity_id === to) ||
        (b.from_entity_id === entityIdA && b.to_entity_id === entityIdB) || // mentor_of (directed) may not canonicalize to (from,to)
        (b.from_entity_id === entityIdB && b.to_entity_id === entityIdA)
    );
}
