import { beforeEach, describe, expect, it } from "vitest";
import { ProjectionsDb } from "../src/projections/db.js";
import { closeBond, findBondsBetween, isBondOpen, openBond } from "../src/relationships/socialBonds.js";
import { freshTestDbPath } from "../src/test/dbPath.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";

let projections: ProjectionsDb;

beforeEach(() => {
  projections = new ProjectionsDb(freshTestDbPath(import.meta.url, "projections"));
});

describe("social bonds (EN-013 Class B)", () => {
  it("peer_of is not in the type vocabulary — the DB rejects it", () => {
    expect(() =>
      projections.insertSocialBond({
        id: "01BADBOND0000000000000000",
        user_id: PRIMARY_USER_ID,
        // @ts-expect-error deliberately invalid type to prove the CHECK constraint fires
        type: "peer_of",
        from_entity_id: "a",
        to_entity_id: "b",
        qualifier: null,
        opened_basis: "inferred",
        interval_start: null,
        interval_end: null,
        source_event_ids: "[]",
        created_at: new Date().toISOString()
      })
    ).toThrow();
  });

  it("opens on inferred evidence — additive, harmless if wrong", () => {
    const bond = openBond(projections, PRIMARY_USER_ID, {
      type: "colleague",
      fromEntityId: "me",
      toEntityId: "priya",
      openedBasis: "inferred",
      sourceEventIds: ["ev-mentioned-coworker"]
    });
    expect(bond.opened_basis).toBe("inferred");
    expect(isBondOpen(bond)).toBe(true);
  });

  it("re-opening the same open bond type for the same pair does not duplicate it", () => {
    const first = openBond(projections, PRIMARY_USER_ID, { type: "colleague", fromEntityId: "me", toEntityId: "priya", openedBasis: "inferred", sourceEventIds: ["e1"] });
    const second = openBond(projections, PRIMARY_USER_ID, { type: "colleague", fromEntityId: "me", toEntityId: "priya", openedBasis: "inferred", sourceEventIds: ["e2"] });
    expect(first.id).toBe(second.id);
    expect(findBondsBetween(projections, PRIMARY_USER_ID, "me", "priya")).toHaveLength(1);
  });

  it("accretion: a colleague bond and a friend bond coexist concurrently on the same pair", () => {
    openBond(projections, PRIMARY_USER_ID, { type: "colleague", fromEntityId: "me", toEntityId: "priya", openedBasis: "inferred", sourceEventIds: ["e1"] });
    openBond(projections, PRIMARY_USER_ID, { type: "friend", fromEntityId: "me", toEntityId: "priya", openedBasis: "stated", sourceEventIds: ["e2"] });

    const bonds = findBondsBetween(projections, PRIMARY_USER_ID, "me", "priya");
    expect(bonds).toHaveLength(2);
    expect(bonds.every((b) => isBondOpen(b))).toBe(true); // the colleague interval did NOT close when friend opened
    expect(new Set(bonds.map((b) => b.type))).toEqual(new Set(["colleague", "friend"]));
  });

  it("closes ONLY on an explicit stated call with provenance — never as a side effect of opening another bond", () => {
    const colleague = openBond(projections, PRIMARY_USER_ID, { type: "colleague", fromEntityId: "me", toEntityId: "priya", openedBasis: "inferred", sourceEventIds: ["e1"] });
    openBond(projections, PRIMARY_USER_ID, { type: "friend", fromEntityId: "me", toEntityId: "priya", openedBasis: "stated", sourceEventIds: ["e2"] });
    expect(isBondOpen(projections.getSocialBondById(colleague.id)!)).toBe(true);

    closeBond(projections, colleague.id, "2026-06-01", "ev-stated-falling-out");
    expect(isBondOpen(projections.getSocialBondById(colleague.id)!)).toBe(false);
  });

  it("SILENCE CANNOT CLOSE AN INTERVAL — only stated evidence can (EN-013)", () => {
    const neverMentionedAgain = openBond(projections, PRIMARY_USER_ID, {
      type: "friend",
      fromEntityId: "me",
      toEntityId: "diego",
      openedBasis: "inferred",
      sourceEventIds: ["e-opened"]
    });
    const explicitlyEnded = openBond(projections, PRIMARY_USER_ID, {
      type: "friend",
      fromEntityId: "me",
      toEntityId: "someone-else",
      openedBasis: "stated",
      sourceEventIds: ["e-opened-2"]
    });

    // Simulate the passage of time / repeated non-mention: nothing is ever
    // called for `neverMentionedAgain`. There is no idle-timeout sweep, no
    // reflection-loop closure, no code path in this codebase that reacts to
    // absence — so it must still be open no matter how much "time" passes.
    for (let simulatedCheckIn = 0; simulatedCheckIn < 50; simulatedCheckIn++) {
      // deliberately doing nothing to `neverMentionedAgain` here
    }
    expect(isBondOpen(projections.getSocialBondById(neverMentionedAgain.id)!)).toBe(true);

    // Only the explicit, stated closeBond call — driven by real evidence —
    // can close an interval.
    closeBond(projections, explicitlyEnded.id, "2026-06-01", "ev-stated-we-dont-talk-anymore");
    expect(isBondOpen(projections.getSocialBondById(explicitlyEnded.id)!)).toBe(false);

    // The unmentioned bond remains completely unaffected by the other's closure.
    expect(isBondOpen(projections.getSocialBondById(neverMentionedAgain.id)!)).toBe(true);
  });

  it("closing twice is a no-op, not an error, and does not move the close date", () => {
    const bond = openBond(projections, PRIMARY_USER_ID, { type: "friend", fromEntityId: "me", toEntityId: "diego", openedBasis: "stated", sourceEventIds: ["e1"] });
    closeBond(projections, bond.id, "2026-01-01", "ev-close-1");
    expect(() => closeBond(projections, bond.id, "2026-06-01", "ev-close-2")).not.toThrow();
    expect(projections.getSocialBondById(bond.id)!.interval_end).toBe("2026-01-01");
  });

  it("romantic never graduates to structural — closing/opening a romantic bond never touches structural_atoms", () => {
    openBond(projections, PRIMARY_USER_ID, { type: "romantic", fromEntityId: "me", toEntityId: "sam", openedBasis: "stated", sourceEventIds: ["e1"] });
    expect(projections.listStructuralAtoms(PRIMARY_USER_ID)).toHaveLength(0);
  });
});
