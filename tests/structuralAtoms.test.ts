import { beforeEach, describe, expect, it } from "vitest";
import { ProjectionsDb } from "../src/projections/db.js";
import {
  assertParentOf,
  assertSiblingOf,
  assertSpouseOf,
  closeSpouseOf,
  deriveSiblingsFromParents,
  siblingDegree
} from "../src/relationships/structuralAtoms.js";
import { freshTestDbPath } from "../src/test/dbPath.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";

let projections: ProjectionsDb;

beforeEach(() => {
  projections = new ProjectionsDb(freshTestDbPath(import.meta.url, "projections"));
});

describe("structural atoms (EN-013 Class A)", () => {
  it("child_of is mechanically rejected at the DB layer — it is never stored", () => {
    expect(() =>
      projections.insertStructuralAtom({
        id: "01BADATOM00000000000000",
        user_id: PRIMARY_USER_ID,
        // @ts-expect-error deliberately invalid type to prove the CHECK constraint fires
        type: "child_of",
        from_entity_id: "child",
        to_entity_id: "parent",
        basis: "stated",
        interval_start: null,
        interval_end: null,
        source_event_ids: "[]",
        created_at: new Date().toISOString()
      })
    ).toThrow();
  });

  it("assertParentOf is directed and idempotent", () => {
    const a = assertParentOf(projections, PRIMARY_USER_ID, "mom", "kid", ["ev1"]);
    const b = assertParentOf(projections, PRIMARY_USER_ID, "mom", "kid", ["ev2"]);
    expect(a.id).toBe(b.id); // same atom, not duplicated
    expect(projections.listStructuralAtoms(PRIMARY_USER_ID, "parent_of")).toHaveLength(1);
  });

  it("assertSpouseOf is symmetric — argument order doesn't matter", () => {
    const a = assertSpouseOf(projections, PRIMARY_USER_ID, "alice", "bob", ["ev1"]);
    const b = assertSpouseOf(projections, PRIMARY_USER_ID, "bob", "alice", ["ev2"]);
    expect(a.id).toBe(b.id);
    expect(projections.listStructuralAtoms(PRIMARY_USER_ID, "spouse_of")).toHaveLength(1);
  });

  it("spouse_of is active by default and closes only on an explicit stated call with provenance", () => {
    const atom = assertSpouseOf(projections, PRIMARY_USER_ID, "alice", "bob", ["ev1"]);
    expect(atom.interval_end).toBeNull();

    closeSpouseOf(projections, atom.id, "2020-01-01", "divorce-event-1");
    const closed = projections.getStructuralAtomById(atom.id)!;
    expect(closed.interval_end).toBe("2020-01-01");
    expect(JSON.parse(closed.source_event_ids)).toContain("divorce-event-1");
  });

  it("closing an already-closed spouse_of atom is a no-op, not an error", () => {
    const atom = assertSpouseOf(projections, PRIMARY_USER_ID, "alice", "bob", ["ev1"]);
    closeSpouseOf(projections, atom.id, "2020-01-01", "ev-close-1");
    expect(() => closeSpouseOf(projections, atom.id, "2021-01-01", "ev-close-2")).not.toThrow();
    expect(projections.getStructuralAtomById(atom.id)!.interval_end).toBe("2020-01-01"); // unchanged
  });

  it("assertSiblingOf is a direct stated claim, symmetric", () => {
    const a = assertSiblingOf(projections, PRIMARY_USER_ID, "amy", "ben", ["ev1"]);
    const b = assertSiblingOf(projections, PRIMARY_USER_ID, "ben", "amy", ["ev2"]);
    expect(a.id).toBe(b.id);
  });

  it("deriveSiblingsFromParents finds full siblings (2 shared parents) and half siblings (1 shared parent)", () => {
    assertParentOf(projections, PRIMARY_USER_ID, "mom", "amy", ["e1"]);
    assertParentOf(projections, PRIMARY_USER_ID, "dad", "amy", ["e2"]);
    assertParentOf(projections, PRIMARY_USER_ID, "mom", "ben", ["e3"]);
    assertParentOf(projections, PRIMARY_USER_ID, "dad", "ben", ["e4"]);
    // Cara shares only "dad" with amy/ben (half-sibling)
    assertParentOf(projections, PRIMARY_USER_ID, "dad", "cara", ["e5"]);

    deriveSiblingsFromParents(projections, PRIMARY_USER_ID);

    expect(siblingDegree(projections, PRIMARY_USER_ID, "amy", "ben")).toBe("full");
    expect(siblingDegree(projections, PRIMARY_USER_ID, "amy", "cara")).toBe("half");
    expect(siblingDegree(projections, PRIMARY_USER_ID, "ben", "cara")).toBe("half");
  });

  it("deriveSiblingsFromParents does not create a sibling_of atom for entities sharing no parent", () => {
    assertParentOf(projections, PRIMARY_USER_ID, "mom", "amy", ["e1"]);
    assertParentOf(projections, PRIMARY_USER_ID, "someone-else", "zed", ["e2"]);

    deriveSiblingsFromParents(projections, PRIMARY_USER_ID);
    expect(siblingDegree(projections, PRIMARY_USER_ID, "amy", "zed")).toBeNull();
  });

  it("deriveSiblingsFromParents is idempotent — running it twice doesn't duplicate atoms", () => {
    assertParentOf(projections, PRIMARY_USER_ID, "mom", "amy", ["e1"]);
    assertParentOf(projections, PRIMARY_USER_ID, "mom", "ben", ["e2"]);
    deriveSiblingsFromParents(projections, PRIMARY_USER_ID);
    deriveSiblingsFromParents(projections, PRIMARY_USER_ID);
    expect(projections.listStructuralAtoms(PRIMARY_USER_ID, "sibling_of")).toHaveLength(1);
  });

  it("a directly-stated sibling claim is not overwritten by parent-intersection derivation", () => {
    const stated = assertSiblingOf(projections, PRIMARY_USER_ID, "amy", "ben", ["e-stated"]);
    assertParentOf(projections, PRIMARY_USER_ID, "mom", "amy", ["e1"]);
    assertParentOf(projections, PRIMARY_USER_ID, "mom", "ben", ["e2"]);
    deriveSiblingsFromParents(projections, PRIMARY_USER_ID);

    const atoms = projections.listStructuralAtoms(PRIMARY_USER_ID, "sibling_of");
    expect(atoms).toHaveLength(1);
    expect(atoms[0]!.id).toBe(stated.id);
    expect(atoms[0]!.basis).toBe("stated"); // not downgraded to derived_from_parents
  });
});
