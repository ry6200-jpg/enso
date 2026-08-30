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
    // Neither call should be rejected — this is a plain, unambiguous first assertion of a
    // fresh pair, then an idempotent re-assertion of the same pair. null here would mean a
    // validation rule misfired on a case that should pass.
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.id).toBe(b!.id); // same atom, not duplicated
    expect(projections.listStructuralAtoms(PRIMARY_USER_ID, "parent_of")).toHaveLength(1);
  });

  it("assertSpouseOf is symmetric — argument order doesn't matter", () => {
    const a = assertSpouseOf(projections, PRIMARY_USER_ID, "alice", "bob", ["ev1"]);
    const b = assertSpouseOf(projections, PRIMARY_USER_ID, "bob", "alice", ["ev2"]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.id).toBe(b!.id);
    expect(projections.listStructuralAtoms(PRIMARY_USER_ID, "spouse_of")).toHaveLength(1);
  });

  it("spouse_of is active by default and closes only on an explicit stated call with provenance", () => {
    const atom = assertSpouseOf(projections, PRIMARY_USER_ID, "alice", "bob", ["ev1"]);
    expect(atom).not.toBeNull();
    expect(atom!.interval_end).toBeNull();

    closeSpouseOf(projections, atom!.id, "2020-01-01", "divorce-event-1");
    const closed = projections.getStructuralAtomById(atom!.id)!;
    expect(closed.interval_end).toBe("2020-01-01");
    expect(JSON.parse(closed.source_event_ids)).toContain("divorce-event-1");
  });

  it("closing an already-closed spouse_of atom is a no-op, not an error", () => {
    const atom = assertSpouseOf(projections, PRIMARY_USER_ID, "alice", "bob", ["ev1"]);
    expect(atom).not.toBeNull();
    closeSpouseOf(projections, atom!.id, "2020-01-01", "ev-close-1");
    expect(() => closeSpouseOf(projections, atom!.id, "2021-01-01", "ev-close-2")).not.toThrow();
    expect(projections.getStructuralAtomById(atom!.id)!.interval_end).toBe("2020-01-01"); // unchanged
  });

  it("assertSiblingOf is a direct stated claim, symmetric", () => {
    const a = assertSiblingOf(projections, PRIMARY_USER_ID, "amy", "ben", ["ev1"]);
    const b = assertSiblingOf(projections, PRIMARY_USER_ID, "ben", "amy", ["ev2"]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.id).toBe(b!.id);
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
    expect(stated).not.toBeNull();
    assertParentOf(projections, PRIMARY_USER_ID, "mom", "amy", ["e1"]);
    assertParentOf(projections, PRIMARY_USER_ID, "mom", "ben", ["e2"]);
    deriveSiblingsFromParents(projections, PRIMARY_USER_ID);

    const atoms = projections.listStructuralAtoms(PRIMARY_USER_ID, "sibling_of");
    expect(atoms).toHaveLength(1);
    expect(atoms[0]!.id).toBe(stated!.id);
    expect(atoms[0]!.basis).toBe("stated"); // not downgraded to derived_from_parents
  });
});

describe("semantic validation (Bug fix 3 of 3): rules 2/3/4/5", () => {
  describe("rule 2 — no cycle", () => {
    it("rejects a direct inversion (child already an ancestor of the proposed parent)", () => {
      expect(assertParentOf(projections, PRIMARY_USER_ID, "mom", "kid", ["e1"])).not.toBeNull();
      const inverted = assertParentOf(projections, PRIMARY_USER_ID, "kid", "mom", ["e2"]);
      expect(inverted).toBeNull();
      expect(projections.listStructuralAtoms(PRIMARY_USER_ID, "parent_of")).toHaveLength(1);
    });

    it("rejects a multi-hop cycle, not just a direct inversion", () => {
      expect(assertParentOf(projections, PRIMARY_USER_ID, "grandparent", "parent", ["e1"])).not.toBeNull();
      expect(assertParentOf(projections, PRIMARY_USER_ID, "parent", "child", ["e2"])).not.toBeNull();
      // child -> grandparent would close a 3-hop cycle (grandparent -> parent -> child -> grandparent)
      const closing = assertParentOf(projections, PRIMARY_USER_ID, "child", "grandparent", ["e3"]);
      expect(closing).toBeNull();
      expect(projections.listStructuralAtoms(PRIMARY_USER_ID, "parent_of")).toHaveLength(2);
    });

    it("does not fire on a genuinely new, non-cyclic parent_of assertion", () => {
      expect(assertParentOf(projections, PRIMARY_USER_ID, "mom", "kid", ["e1"])).not.toBeNull();
      const secondParent = assertParentOf(projections, PRIMARY_USER_ID, "dad", "kid", ["e2"]);
      expect(secondParent).not.toBeNull();
      expect(projections.listStructuralAtoms(PRIMARY_USER_ID, "parent_of")).toHaveLength(2);
    });
  });

  describe("rule 3 — parent_of and sibling_of cannot both exist between the same pair", () => {
    it("rejects parent_of when sibling_of already exists between the pair", () => {
      expect(assertSiblingOf(projections, PRIMARY_USER_ID, "amy", "ben", ["e1"])).not.toBeNull();
      expect(assertParentOf(projections, PRIMARY_USER_ID, "amy", "ben", ["e2"])).toBeNull();
    });

    it("rejects sibling_of when parent_of already exists between the pair", () => {
      expect(assertParentOf(projections, PRIMARY_USER_ID, "mom", "kid", ["e1"])).not.toBeNull();
      expect(assertSiblingOf(projections, PRIMARY_USER_ID, "mom", "kid", ["e2"])).toBeNull();
    });

    it("does not fire between an unrelated pair", () => {
      expect(assertSiblingOf(projections, PRIMARY_USER_ID, "amy", "ben", ["e1"])).not.toBeNull();
    });
  });

  describe("rule 4 — self-loop rejected on all three types", () => {
    it("rejects parent_of(x, x)", () => {
      expect(assertParentOf(projections, PRIMARY_USER_ID, "solo", "solo", ["e1"])).toBeNull();
      expect(projections.listStructuralAtoms(PRIMARY_USER_ID, "parent_of")).toHaveLength(0);
    });

    it("rejects sibling_of(x, x)", () => {
      expect(assertSiblingOf(projections, PRIMARY_USER_ID, "solo", "solo", ["e1"])).toBeNull();
    });

    it("rejects spouse_of(x, x)", () => {
      expect(assertSpouseOf(projections, PRIMARY_USER_ID, "solo", "solo", ["e1"])).toBeNull();
    });

    it("does not fire on a normal, distinct pair", () => {
      expect(assertParentOf(projections, PRIMARY_USER_ID, "mom", "kid", ["e1"])).not.toBeNull();
    });
  });

  describe("rule 5 — parent_of vs spouse_of, sibling_of vs spouse_of", () => {
    it("rejects spouse_of when parent_of already exists between the pair", () => {
      expect(assertParentOf(projections, PRIMARY_USER_ID, "mom", "kid", ["e1"])).not.toBeNull();
      expect(assertSpouseOf(projections, PRIMARY_USER_ID, "mom", "kid", ["e2"])).toBeNull();
    });

    it("rejects parent_of when spouse_of already exists between the pair", () => {
      expect(assertSpouseOf(projections, PRIMARY_USER_ID, "alice", "bob", ["e1"])).not.toBeNull();
      expect(assertParentOf(projections, PRIMARY_USER_ID, "alice", "bob", ["e2"])).toBeNull();
    });

    it("rejects spouse_of when sibling_of already exists between the pair", () => {
      expect(assertSiblingOf(projections, PRIMARY_USER_ID, "amy", "ben", ["e1"])).not.toBeNull();
      expect(assertSpouseOf(projections, PRIMARY_USER_ID, "amy", "ben", ["e2"])).toBeNull();
    });

    it("rejects sibling_of when spouse_of already exists between the pair", () => {
      expect(assertSpouseOf(projections, PRIMARY_USER_ID, "alice", "bob", ["e1"])).not.toBeNull();
      expect(assertSiblingOf(projections, PRIMARY_USER_ID, "alice", "bob", ["e2"])).toBeNull();
    });

    it("does not fire between an unrelated pair", () => {
      expect(assertSpouseOf(projections, PRIMARY_USER_ID, "alice", "bob", ["e1"])).not.toBeNull();
    });
  });

  it("allows two DIFFERENT entities to hold spouse_of toward the same anchor — Bug 2's co-reference trigger depends on this multiplicity surviving", () => {
    const first = assertSpouseOf(projections, PRIMARY_USER_ID, "husband-placeholder", "alice", ["e1"]);
    const second = assertSpouseOf(projections, PRIMARY_USER_ID, "ah-song", "alice", ["e2"]);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(projections.listStructuralAtoms(PRIMARY_USER_ID, "spouse_of")).toHaveLength(2);
  });

  it("validation runs on a derived sibling_of atom too, not just a stated one — deriveSiblingsFromParents now goes through assertSiblingOf", () => {
    assertParentOf(projections, PRIMARY_USER_ID, "mom", "amy", ["e1"]);
    assertParentOf(projections, PRIMARY_USER_ID, "mom", "ben", ["e2"]);
    // A separately-asserted parent_of directly between amy and ben (not cyclic, so rule 2 doesn't
    // catch it — amy is not already ben's ancestor) sets up rule 3 to catch the sibling_of that
    // would otherwise be derived from their shared parent "mom".
    expect(assertParentOf(projections, PRIMARY_USER_ID, "amy", "ben", ["e3"])).not.toBeNull();

    const created = deriveSiblingsFromParents(projections, PRIMARY_USER_ID);

    expect(created).toHaveLength(0); // rejected by rule 3, never written
    expect(projections.listStructuralAtoms(PRIMARY_USER_ID, "sibling_of")).toHaveLength(0);
  });
});
