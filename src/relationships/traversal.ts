import type { ProjectionsDb, StructuralAtomRow } from "../projections/db.js";
import { siblingDegree } from "./structuralAtoms.js";

/**
 * Graph traversal over Class A structural atoms (EN-014). Every derived
 * relation here (grandparent, cousin, in-law) is computed fresh from the
 * stored atoms — never itself stored as an opaque label (EN-013).
 *
 * Capped sibling-hop rule (EN-014, R19): rather than a generic path-search
 * engine that could chain sibling edges without bound (the shape of bug
 * R19 names — an uncapped sibling hop letting traversal treat "my
 * sibling's sibling" or "my cousin's cousin" as new, distinct
 * relationships), each derivation below is an explicit, bounded function
 * that uses at most one sibling-type step. There is no generic
 * "traverse the graph" entry point that could be asked to chain further.
 * NOTE: this specific cap is my best-effort reconstruction from the spec
 * text alone — Part 2 was blocked on access to the old Enso repo at the
 * time this was written, so treat the exact bound as provisional pending
 * that comparison (see the Phase 3 report).
 */

function isActive(atom: StructuralAtomRow, asOfDate?: string): boolean {
  if (!asOfDate) return atom.interval_end === null;
  if (atom.interval_start !== null && atom.interval_start > asOfDate) return false; // hadn't started yet
  if (atom.interval_end !== null && atom.interval_end <= asOfDate) return false; // already ended by then
  return true;
}

export function getParents(projections: ProjectionsDb, userId: string, entityId: string): string[] {
  return projections
    .listStructuralAtoms(userId, "parent_of")
    .filter((a) => a.to_entity_id === entityId)
    .map((a) => a.from_entity_id);
}

export function getChildren(projections: ProjectionsDb, userId: string, entityId: string): string[] {
  return projections
    .listStructuralAtoms(userId, "parent_of")
    .filter((a) => a.from_entity_id === entityId)
    .map((a) => a.to_entity_id);
}

export function getSpouses(projections: ProjectionsDb, userId: string, entityId: string, asOfDate?: string): string[] {
  return projections
    .listStructuralAtoms(userId, "spouse_of")
    .filter((a) => (a.from_entity_id === entityId || a.to_entity_id === entityId) && isActive(a, asOfDate))
    .map((a) => (a.from_entity_id === entityId ? a.to_entity_id : a.from_entity_id));
}

export interface SiblingResult {
  entityId: string;
  degree: "full" | "half" | "stated_only";
}

/** Union of stated sibling_of atoms and parent-intersection-derived ones, with degree computed by traversal (EN-013). */
export function getSiblings(projections: ProjectionsDb, userId: string, entityId: string): SiblingResult[] {
  const atoms = projections
    .listStructuralAtoms(userId, "sibling_of")
    .filter((a) => a.from_entity_id === entityId || a.to_entity_id === entityId);

  const results = new Map<string, SiblingResult>();
  for (const atom of atoms) {
    const otherId = atom.from_entity_id === entityId ? atom.to_entity_id : atom.from_entity_id;
    const degree = siblingDegree(projections, userId, entityId, otherId) ?? "stated_only";
    results.set(otherId, { entityId: otherId, degree });
  }
  return [...results.values()];
}

export function getGrandparents(projections: ProjectionsDb, userId: string, entityId: string): string[] {
  const parents = getParents(projections, userId, entityId);
  const grandparents = new Set<string>();
  for (const parent of parents) {
    for (const gp of getParents(projections, userId, parent)) grandparents.add(gp);
  }
  return [...grandparents];
}

export function getGrandchildren(projections: ProjectionsDb, userId: string, entityId: string): string[] {
  const children = getChildren(projections, userId, entityId);
  const grandchildren = new Set<string>();
  for (const child of children) {
    for (const gc of getChildren(projections, userId, child)) grandchildren.add(gc);
  }
  return [...grandchildren];
}

/** Cousins: children of (siblings of (parents of entityId)) — exactly one sibling hop. */
export function getCousins(projections: ProjectionsDb, userId: string, entityId: string): string[] {
  const parents = getParents(projections, userId, entityId);
  const cousins = new Set<string>();
  for (const parent of parents) {
    const parentsSiblings = getSiblings(projections, userId, parent);
    for (const auntOrUncle of parentsSiblings) {
      for (const cousin of getChildren(projections, userId, auntOrUncle.entityId)) {
        if (cousin !== entityId) cousins.add(cousin);
      }
    }
  }
  return [...cousins];
}

export interface InLawResult {
  entityId: string;
  relation: "sibling_in_law" | "parent_in_law" | "child_in_law";
}

/**
 * In-laws (EN-013: spouse_of is the only bond that generates in-law
 * derivations). Three explicit paths, each using at most one sibling hop
 * or one spouse hop beyond the direct relation:
 *  - spouse's siblings, and sibling's spouses -> sibling_in_law
 *  - spouse's parents -> parent_in_law
 *  - child's spouse -> child_in_law
 * Historical (ex-)spouse_of intervals may also generate in-laws if asOfDate
 * is supplied, per EN-013's "traversal defaults to active intervals but
 * may evaluate historical ones (ex-in-law paths)".
 */
export function getInLaws(projections: ProjectionsDb, userId: string, entityId: string, asOfDate?: string): InLawResult[] {
  const results = new Map<string, InLawResult>();

  const spouses = getSpouses(projections, userId, entityId, asOfDate);
  for (const spouse of spouses) {
    for (const sibling of getSiblings(projections, userId, spouse)) {
      results.set(sibling.entityId, { entityId: sibling.entityId, relation: "sibling_in_law" });
    }
    for (const parent of getParents(projections, userId, spouse)) {
      results.set(parent, { entityId: parent, relation: "parent_in_law" });
    }
  }

  for (const sibling of getSiblings(projections, userId, entityId)) {
    for (const siblingSpouse of getSpouses(projections, userId, sibling.entityId, asOfDate)) {
      results.set(siblingSpouse, { entityId: siblingSpouse, relation: "sibling_in_law" });
    }
  }

  for (const child of getChildren(projections, userId, entityId)) {
    for (const childSpouse of getSpouses(projections, userId, child, asOfDate)) {
      results.set(childSpouse, { entityId: childSpouse, relation: "child_in_law" });
    }
  }

  return [...results.values()];
}
