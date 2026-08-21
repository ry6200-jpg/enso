import { describe, expect, it } from "vitest";
import {
  findFuzzyNameMatch,
  findUnambiguousPartialNameMatch,
  hasConflictingStructuralAtom,
  isPlausibleNameVariant,
  normalizeForMatching
} from "../src/entities/resolutionCascade.js";

describe("normalizeForMatching (EN-012, ported from old Enso)", () => {
  it("treats apostrophe/whitespace variants as equal", () => {
    expect(normalizeForMatching("Hugo's")).toBe(normalizeForMatching("Hugos"));
    expect(normalizeForMatching("  Amy  ")).toBe(normalizeForMatching("Amy"));
  });

  it("strips hyphens entirely rather than treating them as a space (matches old Enso exactly)", () => {
    expect(normalizeForMatching("Mary-Jane")).toBe("maryjane");
    expect(normalizeForMatching("Mary Jane")).toBe("mary jane");
    expect(normalizeForMatching("Mary-Jane")).not.toBe(normalizeForMatching("Mary Jane"));
  });
});

describe("findUnambiguousPartialNameMatch (EN-012)", () => {
  it("matches a first-name-only mention against an already-known fuller name", () => {
    const match = findUnambiguousPartialNameMatch("Irene", [{ id: "1", name: "Irene Yap" }]);
    expect(match?.id).toBe("1");
  });

  it("matches the reverse direction too — a fuller name against an already-known first name", () => {
    const match = findUnambiguousPartialNameMatch("Irene Yap", [{ id: "1", name: "Irene" }]);
    expect(match?.id).toBe("1");
  });

  it("backs off when two candidates both prefix-match — never guesses among multiple", () => {
    const match = findUnambiguousPartialNameMatch("Irene", [
      { id: "1", name: "Irene Yap" },
      { id: "2", name: "Irene Chen" }
    ]);
    expect(match).toBeUndefined();
  });

  it("does not match on a word appearing anywhere in the name, only a strict prefix", () => {
    // "Yap" alone should not match "Irene Yap" this way (that's not a prefix).
    const match = findUnambiguousPartialNameMatch("Yap", [{ id: "1", name: "Irene Yap" }]);
    expect(match).toBeUndefined();
  });
});

describe("isPlausibleNameVariant / findFuzzyNameMatch (EN-012)", () => {
  it("recognizes a close respelling within the edit-distance bound", () => {
    expect(isPlausibleNameVariant("xiomara", "chiomara")).toBe(true);
  });

  it("rejects names shorter than the minimum fuzzy length even if very close", () => {
    expect(isPlausibleNameVariant("al", "ed")).toBe(false); // both too short to participate at all
  });

  it("rejects exact matches (handled by an earlier, higher-confidence step, not this one)", () => {
    expect(isPlausibleNameVariant("amy", "amy")).toBe(false);
  });

  it("rejects genuinely different names of similar length", () => {
    expect(isPlausibleNameVariant("sarah", "diego")).toBe(false);
  });

  it("findFuzzyNameMatch backs off when two candidates are both plausible variants", () => {
    const match = findFuzzyNameMatch("xiomara", [
      { id: "1", name: "Chiomara" },
      { id: "2", name: "Xiomera" }
    ]);
    expect(match).toBeUndefined();
  });

  it("findFuzzyNameMatch matches when exactly one candidate is a plausible variant", () => {
    const match = findFuzzyNameMatch("xiomara", [{ id: "1", name: "Chiomara" }, { id: "2", name: "Diego" }]);
    expect(match?.id).toBe("1");
  });
});

describe("hasConflictingStructuralAtom (EN-012, counterparty-scoped kinship comparison)", () => {
  it("no existing atom toward this counterparty — not a conflict (nothing to compare)", () => {
    expect(hasConflictingStructuralAtom([], "sibling_of")).toBe(false);
  });

  it("same type toward the same counterparty — not a conflict (reconfirmation)", () => {
    expect(hasConflictingStructuralAtom(["sibling_of"], "sibling_of")).toBe(false);
  });

  it("different type toward the same counterparty — a conflict (can't be both parent and sibling)", () => {
    expect(hasConflictingStructuralAtom(["parent_of"], "sibling_of")).toBe(true);
  });
});
