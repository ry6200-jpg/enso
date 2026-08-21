import { beforeEach, describe, expect, it } from "vitest";
import { ProjectionsDb } from "../src/projections/db.js";
import { assertParentOf, assertSpouseOf, closeSpouseOf, deriveSiblingsFromParents } from "../src/relationships/structuralAtoms.js";
import { getCousins, getGrandchildren, getGrandparents, getInLaws, getSiblings, getSpouses } from "../src/relationships/traversal.js";
import { freshTestDbPath } from "../src/test/dbPath.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";

let projections: ProjectionsDb;

beforeEach(() => {
  projections = new ProjectionsDb(freshTestDbPath(import.meta.url, "projections"));
});

describe("traversal (EN-014): derived relations are computed, never stored", () => {
  it("getGrandparents walks two parent_of hops", () => {
    assertParentOf(projections, PRIMARY_USER_ID, "mom", "me", ["e1"]);
    assertParentOf(projections, PRIMARY_USER_ID, "grandma", "mom", ["e2"]);
    assertParentOf(projections, PRIMARY_USER_ID, "grandpa", "mom", ["e3"]);

    const grandparents = getGrandparents(projections, PRIMARY_USER_ID, "me");
    expect(new Set(grandparents)).toEqual(new Set(["grandma", "grandpa"]));

    // never stored as an atom — no 'grandparent_of' type exists at all
    expect(projections.listStructuralAtoms(PRIMARY_USER_ID).every((a) => a.type !== ("grandparent_of" as never))).toBe(true);
  });

  it("getGrandchildren is the inverse", () => {
    assertParentOf(projections, PRIMARY_USER_ID, "me", "kid", ["e1"]);
    assertParentOf(projections, PRIMARY_USER_ID, "kid", "grandkid", ["e2"]);
    expect(getGrandchildren(projections, PRIMARY_USER_ID, "me")).toEqual(["grandkid"]);
  });

  it("getCousins: parent's sibling's child, exactly one sibling hop", () => {
    // mom and aunt are full siblings (share both grandparents)
    assertParentOf(projections, PRIMARY_USER_ID, "grandma", "mom", ["e1"]);
    assertParentOf(projections, PRIMARY_USER_ID, "grandpa", "mom", ["e2"]);
    assertParentOf(projections, PRIMARY_USER_ID, "grandma", "aunt", ["e3"]);
    assertParentOf(projections, PRIMARY_USER_ID, "grandpa", "aunt", ["e4"]);
    deriveSiblingsFromParents(projections, PRIMARY_USER_ID);

    assertParentOf(projections, PRIMARY_USER_ID, "mom", "me", ["e5"]);
    assertParentOf(projections, PRIMARY_USER_ID, "aunt", "cousin1", ["e6"]);
    assertParentOf(projections, PRIMARY_USER_ID, "aunt", "cousin2", ["e7"]);

    const cousins = getCousins(projections, PRIMARY_USER_ID, "me");
    expect(new Set(cousins)).toEqual(new Set(["cousin1", "cousin2"]));
  });

  it("sibling hop is capped at one: a cousin's own cousins are not reachable through getCousins on the original person", () => {
    // Build a second generation beyond first cousins and confirm getCousins
    // does not cascade into "cousin's cousins" by construction (there is no
    // recursive/generic path search to chain sibling hops through).
    assertParentOf(projections, PRIMARY_USER_ID, "grandma", "mom", ["e1"]);
    assertParentOf(projections, PRIMARY_USER_ID, "grandma", "aunt", ["e2"]);
    deriveSiblingsFromParents(projections, PRIMARY_USER_ID);
    assertParentOf(projections, PRIMARY_USER_ID, "mom", "me", ["e3"]);
    assertParentOf(projections, PRIMARY_USER_ID, "aunt", "cousin1", ["e4"]);
    // cousin1 has their own (unrelated-to-me) cousin on the other side of their family
    assertParentOf(projections, PRIMARY_USER_ID, "unrelated-grandparent", "uncle-of-cousin1", ["e5"]);
    assertParentOf(projections, PRIMARY_USER_ID, "uncle-of-cousin1", "second-cousin", ["e6"]);

    const myCousins = getCousins(projections, PRIMARY_USER_ID, "me");
    expect(myCousins).toEqual(["cousin1"]);
    expect(myCousins).not.toContain("second-cousin");
  });

  it("getSiblings reports full vs half degree", () => {
    assertParentOf(projections, PRIMARY_USER_ID, "mom", "amy", ["e1"]);
    assertParentOf(projections, PRIMARY_USER_ID, "dad", "amy", ["e2"]);
    assertParentOf(projections, PRIMARY_USER_ID, "mom", "ben", ["e3"]);
    assertParentOf(projections, PRIMARY_USER_ID, "dad", "ben", ["e4"]);
    assertParentOf(projections, PRIMARY_USER_ID, "dad", "cara", ["e5"]);
    deriveSiblingsFromParents(projections, PRIMARY_USER_ID);

    const siblings = getSiblings(projections, PRIMARY_USER_ID, "amy");
    const byId = Object.fromEntries(siblings.map((s) => [s.entityId, s.degree]));
    expect(byId["ben"]).toBe("full");
    expect(byId["cara"]).toBe("half");
  });

  it("getSpouses respects active vs closed intervals, and historical evaluation via asOfDate (EN-013 ex-in-law paths)", () => {
    const marriage = assertSpouseOf(projections, PRIMARY_USER_ID, "me", "ex", ["e1"], "2010-01-01");
    closeSpouseOf(projections, marriage.id, "2015-01-01", "ev-divorce");

    expect(getSpouses(projections, PRIMARY_USER_ID, "me")).toEqual([]); // active-only default excludes it
    expect(getSpouses(projections, PRIMARY_USER_ID, "me", "2012-01-01")).toEqual(["ex"]); // was active as of that date
  });

  it("getInLaws: spouse's sibling, sibling's spouse, and spouse's parent all resolve to the right relation label", () => {
    assertSpouseOf(projections, PRIMARY_USER_ID, "me", "spouse", ["e1"]);
    assertParentOf(projections, PRIMARY_USER_ID, "spouse-mom", "spouse", ["e2"]);
    assertParentOf(projections, PRIMARY_USER_ID, "spouse-mom", "spouse-sibling", ["e3"]);
    deriveSiblingsFromParents(projections, PRIMARY_USER_ID);

    assertParentOf(projections, PRIMARY_USER_ID, "my-mom", "me", ["e4"]);
    assertParentOf(projections, PRIMARY_USER_ID, "my-mom", "my-sibling", ["e5"]);
    deriveSiblingsFromParents(projections, PRIMARY_USER_ID);
    assertSpouseOf(projections, PRIMARY_USER_ID, "my-sibling", "sibling-spouse", ["e6"]);

    const inLaws = getInLaws(projections, PRIMARY_USER_ID, "me");
    const byId = Object.fromEntries(inLaws.map((r) => [r.entityId, r.relation]));

    expect(byId["spouse-sibling"]).toBe("sibling_in_law");
    expect(byId["spouse-mom"]).toBe("parent_in_law");
    expect(byId["sibling-spouse"]).toBe("sibling_in_law");
  });

  it("romantic bonds never generate in-laws — only an explicit spouse_of atom does (EN-013)", () => {
    // No spouse_of exists — only a hypothetical romantic bond (tested separately in socialBonds.test.ts).
    const inLaws = getInLaws(projections, PRIMARY_USER_ID, "me");
    expect(inLaws).toEqual([]);
  });

  it("getSpouses(asOfDate) correctly excludes a marriage that hadn't started yet as of that date (EN-017)", () => {
    // Regression check: an earlier version of isActive() only checked
    // interval_end, so a marriage with interval_end === null (still
    // ongoing) was reported as active for ANY asOfDate, including dates
    // before the marriage started.
    assertSpouseOf(projections, PRIMARY_USER_ID, "me", "spouse", ["e1"], "2020-06-01");
    expect(getSpouses(projections, PRIMARY_USER_ID, "me", "2015-01-01")).toEqual([]); // before the wedding
    expect(getSpouses(projections, PRIMARY_USER_ID, "me", "2021-01-01")).toEqual(["spouse"]); // after
  });
});
