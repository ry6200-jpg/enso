import { newId } from "../ids.js";
import type { ProjectionsDb, StructuralAtomRow } from "../projections/db.js";

/**
 * Class A structural atoms (EN-013): objective, binary primitives — the
 * only edges derivation rules operate on. `child_of` is deliberately never
 * written: it is `parent_of` read backward, and double-writing both
 * directions invites contradiction on correction. `spouse_of` and
 * `sibling_of` are symmetric, so a pair is stored as exactly one row with a
 * canonical (sorted) entity-id order — callers never need to know or care
 * which side they pass first.
 *
 * Semantic validation (Bug fix 3 of 3): assertParentOf/assertSiblingOf/
 * assertSpouseOf previously checked only whether the exact pair already
 * existed (idempotency), never whether the claim itself was plausible. A
 * real corpus example: three siblings all recorded as parent_of the same
 * two people, and a daughter recorded as parent_of both her own parents —
 * all from extraction errors a bulk re-extraction would hit again with no
 * net. Four rules now run before any of the three writes:
 *   2. No cycle — a full ancestor walk up from the proposed parent; reject
 *      if the proposed child is already an ancestor (catches any-length
 *      chains, not just a direct inversion).
 *   3. parent_of and sibling_of cannot both exist between the same pair.
 *   4. Self-loop (fromId === toId) rejected on all three types.
 *   5. parent_of vs spouse_of, and sibling_of vs spouse_of, same pair,
 *      rejected.
 * (Kept the original numbering from the design report rather than
 * renumbering after removing rule 1, below, so this comment and the
 * rejection-reason strings stay traceable to that report.)
 *
 * Deliberately NOT a rule: capping spouse_of at one holder per anchor.
 * Two different entities holding spouse_of toward the same anchor is
 * exactly the signal Bug 2's co-reference trigger (coReference.ts) detects
 * and asks about — a cap here would silence that mechanism outright.
 *
 * Rule 1 (max 2 open parent_of atoms per child) was built, then removed
 * before this shipped: it rejects legitimate step/adoptive/birth-parent
 * combinations (a real, common family shape this schema has no qualifier
 * field to distinguish from an extraction error), and worse, it rejects
 * CORRECTIONS — a later "she is actually my stepmother, my birth mother
 * was X" arrives as a genuine third atom and would be silently discarded,
 * letting the FIRST claim win over the truer one. It also caught nothing
 * on the real corpus fault that rule 2 doesn't already catch: the
 * inverted Alice bonds are rejected by the cycle check regardless. No cap
 * exists now — see maxOpenParentsForAnyChild on RebuildResult
 * (rebuild.ts) for plain observability instead of a bound.
 *
 * Failure mode mirrors assertAttribute exactly (perception/attributes.ts):
 * a loud console.error with full context, then return null — never throw.
 * Rebuild replays the ENTIRE log from scratch every time (EN-054); a throw
 * on a bad historical atom would mean projections never build again for
 * that account, for any reason, until the bad data somehow left the
 * append-only log. The accepted consequence: on the next rebuild after
 * this ships, the corpus's existing violations are rejected, not
 * corrected — validation can tell a claim contradicts the record, never
 * which direction was actually meant, so those relationships go from
 * wrong-and-displayed to absent, not fixed. That's the intended outcome.
 *
 * Rebuild-time only, inside these three functions — no extraction-time
 * check. Extraction-time validation would only protect future calls; it
 * does nothing for the 323 already-recorded messages this fix exists for,
 * since those already went through extraction and only ever get
 * re-evaluated at rebuild/replay time.
 */

function canonicalPair(a: string, b: string): [string, string] {
  return a <= b ? [a, b] : [b, a];
}

function findExistingSymmetric(
  projections: ProjectionsDb,
  userId: string,
  type: StructuralAtomRow["type"],
  entityIdA: string,
  entityIdB: string
): StructuralAtomRow | undefined {
  const [x, y] = canonicalPair(entityIdA, entityIdB);
  return projections
    .listStructuralAtoms(userId, type)
    .find((row) => row.from_entity_id === x && row.to_entity_id === y);
}

/** Does an atom of `type` already exist between these two entities, in either direction? Used for the cross-type conflict rules (3 and 5) — direction never matters for "these two types can't coexist between the same pair." */
function hasAtomBetween(projections: ProjectionsDb, userId: string, type: StructuralAtomRow["type"], entityIdA: string, entityIdB: string): boolean {
  return projections
    .listStructuralAtoms(userId, type)
    .some((a) => (a.from_entity_id === entityIdA && a.to_entity_id === entityIdB) || (a.from_entity_id === entityIdB && a.to_entity_id === entityIdA));
}

/** Rule 2: does `candidateAncestorId` already appear as an ancestor of `startId`, walking upward through existing OPEN parent_of atoms? Full walk, not a 1-hop check — catches an inversion anywhere in a chain, not just a direct pair. */
function isAncestor(parentOfAtoms: StructuralAtomRow[], candidateAncestorId: string, startId: string): boolean {
  const visited = new Set<string>();
  const queue = [startId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const atom of parentOfAtoms) {
      if (atom.interval_end !== null || atom.to_entity_id !== current) continue;
      if (atom.from_entity_id === candidateAncestorId) return true;
      queue.push(atom.from_entity_id);
    }
  }
  return false;
}

function rejectAtom(fnName: string, type: StructuralAtomRow["type"], fromEntityId: string, toEntityId: string, userId: string, sourceEventIds: string[], rule: string): null {
  // eslint-disable-next-line no-console
  console.error(
    `${fnName}: rejected ${type} (from=${fromEntityId}, to=${toEntityId}) for user ${userId} — ${rule}. Never written to structural_atoms. Source events: ${JSON.stringify(sourceEventIds)}.`
  );
  return null;
}

/** parent_of is directed: fromEntityId is the parent, toEntityId is the child. Never derived — only ever stated. Returns null (never throws) when the claim is rejected — see this file's header comment. */
export function assertParentOf(
  projections: ProjectionsDb,
  userId: string,
  parentEntityId: string,
  childEntityId: string,
  sourceEventIds: string[]
): StructuralAtomRow | null {
  const existing = projections
    .listStructuralAtoms(userId, "parent_of")
    .find((row) => row.from_entity_id === parentEntityId && row.to_entity_id === childEntityId);
  if (existing) return existing;

  if (parentEntityId === childEntityId) {
    return rejectAtom("assertParentOf", "parent_of", parentEntityId, childEntityId, userId, sourceEventIds, "self-loop (rule 4)");
  }

  const parentOfAtoms = projections.listStructuralAtoms(userId, "parent_of");

  if (isAncestor(parentOfAtoms, childEntityId, parentEntityId)) {
    return rejectAtom("assertParentOf", "parent_of", parentEntityId, childEntityId, userId, sourceEventIds, "would create a cycle — proposed child is already an ancestor of proposed parent (rule 2)");
  }

  if (hasAtomBetween(projections, userId, "sibling_of", parentEntityId, childEntityId)) {
    return rejectAtom("assertParentOf", "parent_of", parentEntityId, childEntityId, userId, sourceEventIds, "sibling_of already exists between this pair (rule 3)");
  }

  if (hasAtomBetween(projections, userId, "spouse_of", parentEntityId, childEntityId)) {
    return rejectAtom("assertParentOf", "parent_of", parentEntityId, childEntityId, userId, sourceEventIds, "spouse_of already exists between this pair (rule 5)");
  }

  const row: StructuralAtomRow = {
    id: newId(),
    user_id: userId,
    type: "parent_of",
    from_entity_id: parentEntityId,
    to_entity_id: childEntityId,
    basis: "stated",
    interval_start: null,
    interval_end: null,
    source_event_ids: JSON.stringify([...new Set(sourceEventIds)].sort()),
    created_at: new Date().toISOString()
  };
  projections.insertStructuralAtom(row);
  return row;
}

/**
 * spouse_of is symmetric and carries an interval — active by default,
 * closeable only on stated evidence (EN-013). Returns null (never throws)
 * when rejected. Deliberately NO multiplicity cap (see this file's header
 * comment) — Bug 2's co-reference trigger depends on two different
 * entities being able to hold spouse_of toward the same anchor at once.
 */
export function assertSpouseOf(
  projections: ProjectionsDb,
  userId: string,
  entityIdA: string,
  entityIdB: string,
  sourceEventIds: string[],
  intervalStart: string | null = null
): StructuralAtomRow | null {
  const existing = findExistingSymmetric(projections, userId, "spouse_of", entityIdA, entityIdB);
  if (existing) return existing;

  if (entityIdA === entityIdB) {
    return rejectAtom("assertSpouseOf", "spouse_of", entityIdA, entityIdB, userId, sourceEventIds, "self-loop (rule 4)");
  }

  if (hasAtomBetween(projections, userId, "parent_of", entityIdA, entityIdB)) {
    return rejectAtom("assertSpouseOf", "spouse_of", entityIdA, entityIdB, userId, sourceEventIds, "parent_of already exists between this pair (rule 5)");
  }

  if (hasAtomBetween(projections, userId, "sibling_of", entityIdA, entityIdB)) {
    return rejectAtom("assertSpouseOf", "spouse_of", entityIdA, entityIdB, userId, sourceEventIds, "sibling_of already exists between this pair (rule 5)");
  }

  const [from, to] = canonicalPair(entityIdA, entityIdB);
  const row: StructuralAtomRow = {
    id: newId(),
    user_id: userId,
    type: "spouse_of",
    from_entity_id: from,
    to_entity_id: to,
    basis: "stated",
    interval_start: intervalStart,
    interval_end: null,
    source_event_ids: JSON.stringify([...new Set(sourceEventIds)].sort()),
    created_at: new Date().toISOString()
  };
  projections.insertStructuralAtom(row);
  return row;
}

/**
 * Closes a spouse_of interval (divorce, passing) — stated evidence only.
 * There is deliberately no code path that closes this from silence: the
 * caller must have an event id for the statement that closed it.
 */
export function closeSpouseOf(projections: ProjectionsDb, atomId: string, closedAtDate: string, sourceEventId: string): void {
  const atom = projections.getStructuralAtomById(atomId);
  if (!atom || atom.type !== "spouse_of") {
    throw new Error(`No spouse_of atom with id ${atomId}`);
  }
  if (atom.interval_end !== null) return; // already closed — no-op
  projections.closeStructuralAtom(atomId, closedAtDate, sourceEventId);
}

/**
 * sibling_of is the hybrid: assertable directly by the user, standing
 * alone, OR derived from shared parent_of atoms (deriveSiblingsFromParents
 * below, which calls this with basis "derived_from_parents" rather than
 * writing a row directly — the SAME validation rules run on both origins,
 * since a derived sibling atom is exactly as consequential for traversal
 * as a stated one). Returns null (never throws) when rejected.
 */
export function assertSiblingOf(
  projections: ProjectionsDb,
  userId: string,
  entityIdA: string,
  entityIdB: string,
  sourceEventIds: string[],
  basis: "stated" | "derived_from_parents" = "stated"
): StructuralAtomRow | null {
  const existing = findExistingSymmetric(projections, userId, "sibling_of", entityIdA, entityIdB);
  if (existing) return existing;

  if (entityIdA === entityIdB) {
    return rejectAtom("assertSiblingOf", "sibling_of", entityIdA, entityIdB, userId, sourceEventIds, "self-loop (rule 4)");
  }

  if (hasAtomBetween(projections, userId, "parent_of", entityIdA, entityIdB)) {
    return rejectAtom("assertSiblingOf", "sibling_of", entityIdA, entityIdB, userId, sourceEventIds, "parent_of already exists between this pair (rule 3)");
  }

  if (hasAtomBetween(projections, userId, "spouse_of", entityIdA, entityIdB)) {
    return rejectAtom("assertSiblingOf", "sibling_of", entityIdA, entityIdB, userId, sourceEventIds, "spouse_of already exists between this pair (rule 5)");
  }

  const [from, to] = canonicalPair(entityIdA, entityIdB);
  const row: StructuralAtomRow = {
    id: newId(),
    user_id: userId,
    type: "sibling_of",
    from_entity_id: from,
    to_entity_id: to,
    basis,
    interval_start: null,
    interval_end: null,
    source_event_ids: JSON.stringify([...new Set(sourceEventIds)].sort()),
    created_at: new Date().toISOString()
  };
  projections.insertStructuralAtom(row);
  return row;
}

/**
 * sibling_of is also derivable/verifiable by parent intersection once
 * parents are known (EN-013). Scans all parent_of atoms for the user,
 * finds every pair of entities sharing at least one parent, and records a
 * sibling_of atom for any pair not already asserted — basis
 * 'derived_from_parents' distinguishes it from a directly-stated sibling
 * claim. Run this after parent_of atoms change; it is idempotent.
 *
 * Writes via assertSiblingOf (never a direct insert) so the SAME
 * validation rules (2/3/4/5, see this file's header comment) run on a
 * derived atom exactly as they do on a stated one — derived siblings are
 * what traversal.ts's getSiblings/getCousins/getNiecesAndNephews actually
 * walk, so an unvalidated derived atom would be just as consequential as
 * an unvalidated stated one, arguably more so since it fans out to
 * relations nobody directly asserted. The outer `existing` check here
 * stays (rather than relying on assertSiblingOf's own internal one)
 * specifically so `created` only ever reports rows genuinely NEW this
 * call, not ones assertSiblingOf found already on record.
 */
export function deriveSiblingsFromParents(projections: ProjectionsDb, userId: string): StructuralAtomRow[] {
  const parentAtoms = projections.listStructuralAtoms(userId, "parent_of");
  const parentsByChild = new Map<string, Set<string>>();
  for (const atom of parentAtoms) {
    const set = parentsByChild.get(atom.to_entity_id) ?? new Set<string>();
    set.add(atom.from_entity_id);
    parentsByChild.set(atom.to_entity_id, set);
  }

  const children = [...parentsByChild.keys()];
  const created: StructuralAtomRow[] = [];

  for (let i = 0; i < children.length; i++) {
    for (let j = i + 1; j < children.length; j++) {
      const childA = children[i]!;
      const childB = children[j]!;
      const sharedParents = [...parentsByChild.get(childA)!].filter((p) => parentsByChild.get(childB)!.has(p));
      if (sharedParents.length === 0) continue;

      const existing = findExistingSymmetric(projections, userId, "sibling_of", childA, childB);
      if (existing) continue;

      // provenance is the parent_of atoms, not a direct statement — no source event ids of its own.
      const row = assertSiblingOf(projections, userId, childA, childB, [], "derived_from_parents");
      if (row) created.push(row);
    }
  }

  return created;
}

/** full = 2 shared parents, half = exactly 1 shared parent, per EN-013's "half- and step-distinctions automatically." Step-siblings (0 shared biological parents, linked only via a parent's remarriage) are out of scope here — see report. */
export function siblingDegree(
  projections: ProjectionsDb,
  userId: string,
  entityIdA: string,
  entityIdB: string
): "full" | "half" | null {
  const parentAtoms = projections.listStructuralAtoms(userId, "parent_of");
  const parentsOf = (id: string) => new Set(parentAtoms.filter((a) => a.to_entity_id === id).map((a) => a.from_entity_id));
  const parentsA = parentsOf(entityIdA);
  const parentsB = parentsOf(entityIdB);
  const shared = [...parentsA].filter((p) => parentsB.has(p)).length;
  if (shared >= 2) return "full";
  if (shared === 1) return "half";
  return null;
}
