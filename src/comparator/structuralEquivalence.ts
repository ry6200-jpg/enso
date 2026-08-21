import type { ExtractionStructure } from "../extraction/types.js";
import type { EntityRow } from "../projections/db.js";

export interface StructuralSnapshot {
  entities: { name: string; confirmed: boolean }[];
  relationships: { from: string; to: string; kind: string }[];
  dates: string[];
}

export interface StructuralComparisonResult {
  equivalent: boolean;
  differences: string[];
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function entityKey(e: { name: string; confirmed: boolean }): string {
  return `${normalizeName(e.name)}|confirmed=${e.confirmed}`;
}

function relationshipKey(r: { from: string; to: string; kind: string }): string {
  return `${normalizeName(r.from)}|${r.kind.trim().toLowerCase()}|${normalizeName(r.to)}`;
}

function dateKey(d: string): string {
  const parsed = new Date(d);
  return Number.isNaN(parsed.getTime()) ? d.trim() : parsed.toISOString();
}

function setDiff<T>(a: Set<T>, b: Set<T>): T[] {
  return [...a].filter((x) => !b.has(x));
}

/**
 * Compares two projection snapshots structurally — same entities, same
 * relationships, same dates — not byte-identically (EN-057). LLM (or stub)
 * extraction output can vary in ordering and superficial phrasing between
 * runs; only a difference in the actual set of facts should fail this
 * comparison.
 */
export function compareStructural(
  a: StructuralSnapshot,
  b: StructuralSnapshot
): StructuralComparisonResult {
  const differences: string[] = [];

  const entitiesA = new Set(a.entities.map(entityKey));
  const entitiesB = new Set(b.entities.map(entityKey));
  for (const only of setDiff(entitiesA, entitiesB)) differences.push(`entity only in A: ${only}`);
  for (const only of setDiff(entitiesB, entitiesA)) differences.push(`entity only in B: ${only}`);

  const relA = new Set(a.relationships.map(relationshipKey));
  const relB = new Set(b.relationships.map(relationshipKey));
  for (const only of setDiff(relA, relB)) differences.push(`relationship only in A: ${only}`);
  for (const only of setDiff(relB, relA)) differences.push(`relationship only in B: ${only}`);

  const datesA = new Set(a.dates.map(dateKey));
  const datesB = new Set(b.dates.map(dateKey));
  for (const only of setDiff(datesA, datesB)) differences.push(`date only in A: ${only}`);
  for (const only of setDiff(datesB, datesA)) differences.push(`date only in B: ${only}`);

  return { equivalent: differences.length === 0, differences };
}

export function snapshotFromEntityRows(rows: EntityRow[]): StructuralSnapshot {
  return {
    entities: rows.map((r) => ({ name: r.name, confirmed: r.confirmed === 1 })),
    relationships: [],
    dates: []
  };
}

export function snapshotFromExtraction(structure: ExtractionStructure): StructuralSnapshot {
  return {
    entities: structure.entities.map((e) => ({ name: e.name, confirmed: false })),
    relationships: structure.relationships.map((r) => ({ from: r.from, to: r.to, kind: r.kind })),
    dates: structure.dates
  };
}
