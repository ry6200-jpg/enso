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

// --- Strict-exact comparison (EN-057 v1.5) ---------------------------------
//
// Two strictness levels now exist, matching EN-054's rebuild/reprocess
// split. compareStructural above is deliberately tolerant (normalized
// names, ignores provenance/version) — the right mode for diffing a
// reprocess against an older extractor version, where non-structural
// variation is expected and even informative. Rebuild is different:
// reading the same recorded payloads twice must produce byte-identical
// projections. Any difference — including in casing, provenance, or
// extractor_version — is a bug, not "acceptable variation," so rebuild
// verification does not normalize anything away.

export interface ExactEntityRow {
  name: string;
  confirmed: boolean;
  sourceEventIds: string[];
  extractorVersion: string;
}

export interface ExactComparisonResult {
  equivalent: boolean;
  differences: string[];
}

function exactKey(row: ExactEntityRow): string {
  return JSON.stringify({
    name: row.name,
    confirmed: row.confirmed,
    sourceEventIds: [...row.sourceEventIds].sort(),
    extractorVersion: row.extractorVersion
  });
}

/** Strict-exact comparison for rebuild verification (EN-057 v1.5): no normalization, no tolerance. */
export function compareExact(a: ExactEntityRow[], b: ExactEntityRow[]): ExactComparisonResult {
  const differences: string[] = [];
  const setA = new Set(a.map(exactKey));
  const setB = new Set(b.map(exactKey));
  for (const only of setDiff(setA, setB)) differences.push(`row only in A: ${only}`);
  for (const only of setDiff(setB, setA)) differences.push(`row only in B: ${only}`);
  return { equivalent: differences.length === 0, differences };
}

export function exactRowsFromEntityRows(rows: EntityRow[]): ExactEntityRow[] {
  return rows.map((r) => ({
    name: r.name,
    confirmed: r.confirmed === 1,
    sourceEventIds: JSON.parse(r.source_event_ids) as string[],
    extractorVersion: r.extractor_version
  }));
}
