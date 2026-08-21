import { describe, expect, it } from "vitest";
import { compareStructural, snapshotFromExtraction, type StructuralSnapshot } from "../src/comparator/structuralEquivalence.js";
import type { ExtractionStructure } from "../src/extraction/types.js";

/**
 * A stand-in for a non-deterministic LLM extractor: given the same input, it
 * returns the *same set of facts* but with randomized ordering and
 * randomized surface casing — exactly the kind of non-structural noise real
 * extraction output varies on run to run. Used only to prove the comparator
 * (EN-057) is actually comparing structure, not text.
 */
function randomizedExtract(names: string[]): ExtractionStructure {
  const shuffled = [...names].sort(() => Math.random() - 0.5);
  const entities = shuffled.map((name) => ({
    name: Math.random() < 0.5 ? name.toUpperCase() : name,
    type: "person" as const
  }));
  return { entities, relationships: [], dates: [] };
}

describe("compareStructural (EN-057)", () => {
  it("passes for two runs that agree structurally but differ in ordering and phrasing", () => {
    const names = ["Sarah", "Amelia", "Priya", "Diego"];
    const runA = snapshotFromExtraction(randomizedExtract(names));
    const runB = snapshotFromExtraction(randomizedExtract(names));

    const result = compareStructural(runA, runB);
    expect(result).toEqual({ equivalent: true, differences: [] });
  });

  it("fails when an entity is missing (planted structural difference)", () => {
    const runA = snapshotFromExtraction(randomizedExtract(["Sarah", "Amelia", "Priya"]));
    const runB = snapshotFromExtraction(randomizedExtract(["Sarah", "Amelia"])); // Priya dropped

    const result = compareStructural(runA, runB);
    expect(result.equivalent).toBe(false);
    expect(result.differences.some((d) => d.includes("priya"))).toBe(true);
  });

  it("fails when an entity is added (planted structural difference)", () => {
    const runA = snapshotFromExtraction(randomizedExtract(["Sarah", "Amelia"]));
    const runB = snapshotFromExtraction(randomizedExtract(["Sarah", "Amelia", "Ghost"])); // extra

    const result = compareStructural(runA, runB);
    expect(result.equivalent).toBe(false);
    expect(result.differences.some((d) => d.includes("ghost"))).toBe(true);
  });

  it("fails when the confirmed attestation flag differs — that is structural, not phrasing", () => {
    const a: StructuralSnapshot = { entities: [{ name: "Sarah", confirmed: true }], relationships: [], dates: [] };
    const b: StructuralSnapshot = { entities: [{ name: "Sarah", confirmed: false }], relationships: [], dates: [] };

    const result = compareStructural(a, b);
    expect(result.equivalent).toBe(false);
  });

  it("passes when only date formatting differs, not the date itself", () => {
    const a: StructuralSnapshot = { entities: [], relationships: [], dates: ["2026-08-21T00:00:00.000Z"] };
    const b: StructuralSnapshot = { entities: [], relationships: [], dates: ["2026-08-21T00:00:00Z"] };

    expect(compareStructural(a, b).equivalent).toBe(true);
  });
});
