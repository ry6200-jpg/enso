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

/** parent_of is directed: fromEntityId is the parent, toEntityId is the child. Never derived — only ever stated. */
export function assertParentOf(
  projections: ProjectionsDb,
  userId: string,
  parentEntityId: string,
  childEntityId: string,
  sourceEventIds: string[]
): StructuralAtomRow {
  const existing = projections
    .listStructuralAtoms(userId, "parent_of")
    .find((row) => row.from_entity_id === parentEntityId && row.to_entity_id === childEntityId);
  if (existing) return existing;

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

/** spouse_of is symmetric and carries an interval — active by default, closeable only on stated evidence (EN-013). */
export function assertSpouseOf(
  projections: ProjectionsDb,
  userId: string,
  entityIdA: string,
  entityIdB: string,
  sourceEventIds: string[],
  intervalStart: string | null = null
): StructuralAtomRow {
  const existing = findExistingSymmetric(projections, userId, "spouse_of", entityIdA, entityIdB);
  if (existing) return existing;

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

/** sibling_of is the hybrid: assertable directly by the user, standing alone. */
export function assertSiblingOf(
  projections: ProjectionsDb,
  userId: string,
  entityIdA: string,
  entityIdB: string,
  sourceEventIds: string[]
): StructuralAtomRow {
  const existing = findExistingSymmetric(projections, userId, "sibling_of", entityIdA, entityIdB);
  if (existing) return existing;

  const [from, to] = canonicalPair(entityIdA, entityIdB);
  const row: StructuralAtomRow = {
    id: newId(),
    user_id: userId,
    type: "sibling_of",
    from_entity_id: from,
    to_entity_id: to,
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
 * sibling_of is also derivable/verifiable by parent intersection once
 * parents are known (EN-013). Scans all parent_of atoms for the user,
 * finds every pair of entities sharing at least one parent, and records a
 * sibling_of atom for any pair not already asserted — basis
 * 'derived_from_parents' distinguishes it from a directly-stated sibling
 * claim. Run this after parent_of atoms change; it is idempotent.
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

      const [from, to] = canonicalPair(childA, childB);
      const row: StructuralAtomRow = {
        id: newId(),
        user_id: userId,
        type: "sibling_of",
        from_entity_id: from,
        to_entity_id: to,
        basis: "derived_from_parents",
        interval_start: null,
        interval_end: null,
        source_event_ids: JSON.stringify([]), // provenance is the parent_of atoms, not a direct statement
        created_at: new Date().toISOString()
      };
      projections.insertStructuralAtom(row);
      created.push(row);
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
