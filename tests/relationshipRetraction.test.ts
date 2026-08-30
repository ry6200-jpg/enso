import { beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/events/eventLog.js";
import { ProjectionsDb } from "../src/projections/db.js";
import { rebuildProjections } from "../src/projections/rebuild.js";
import { freshTestDbPath } from "../src/test/dbPath.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";
import { stableKeyOf } from "../src/conversation/coReference.js";
import { buildSelfProfile } from "../src/projections/peopleView.js";
import {
  buildAmbiguousRetractionDirective,
  buildNotFoundRetractionDirective,
  buildRelationshipRetractedDirective,
  buildUnresolvableRetractionDirective,
  resolveRelationshipRetraction,
  type RelationshipRetractionPayload
} from "../src/relationships/relationshipRetraction.js";

let eventLog: EventLog;
let projections: ProjectionsDb;

beforeEach(() => {
  eventLog = new EventLog(freshTestDbPath(import.meta.url, "events"));
  projections = new ProjectionsDb(freshTestDbPath(import.meta.url, "projections"));
});

function appendExtraction(sourceEventId: string, payload: Record<string, unknown>) {
  return eventLog.append({
    type: "extraction_completed",
    actor: "system",
    payload: { sourceEventId, extractorVersion: "message-v7", kind: "message", entities: [], structuralAtoms: [], socialBonds: [], attributes: [], ...payload },
    userId: PRIMARY_USER_ID
  });
}

function msg(text: string) {
  return eventLog.append({ type: "message_sent", actor: "user", payload: { text, attachmentOnly: false }, userId: PRIMARY_USER_ID });
}

function rebuild() {
  return rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);
}

function establishSibling(): void {
  const m = msg("Annissa is my sister.");
  appendExtraction(m.id, {
    entities: [{ name: "Annissa", type: "person" }],
    structuralAtoms: [{ type: "sibling_of", fromName: "Annissa", toName: "me", action: "assert", fromNameIsRoleWord: false, toNameIsRoleWord: false }]
  });
}

function establishFriend(): void {
  const m = msg("Alice is a friend.");
  appendExtraction(m.id, {
    entities: [{ name: "Alice", type: "person" }],
    socialBonds: [{ type: "friend", fromName: "Alice", toName: "me", action: "open", qualifier: null, basis: "stated", fromNameIsRoleWord: false, toNameIsRoleWord: false }]
  });
}

function appendRetraction(payload: RelationshipRetractionPayload) {
  return eventLog.append({ type: "fact_corrected", actor: "user", payload, userId: PRIMARY_USER_ID });
}

describe("resolveRelationshipRetraction", () => {
  it("retracts a structural atom (sibling_of): store='structuralAtom', payload carries the atom's own stable key", () => {
    establishSibling();
    rebuild();
    const entities = projections.listEntities(PRIMARY_USER_ID);
    const outcome = resolveRelationshipRetraction("Annissa", "me", "sibling_of", PRIMARY_USER_ID, entities, [], projections.listStructuralAtoms(PRIMARY_USER_ID), []);
    expect(outcome.outcome).toBe("retracted");
    if (outcome.outcome !== "retracted") return;
    expect(outcome.payload.store).toBe("structuralAtom");
    expect(outcome.payload.relationType).toBe("sibling_of");
    const atom = projections.listStructuralAtoms(PRIMARY_USER_ID)[0]!;
    expect(outcome.payload.targetStableKey).toBe(stableKeyOf(atom));
  });

  it("retracts a social bond (friend): store='socialBond'", () => {
    establishFriend();
    rebuild();
    const entities = projections.listEntities(PRIMARY_USER_ID);
    const outcome = resolveRelationshipRetraction("Alice", "me", "friend", PRIMARY_USER_ID, entities, [], [], projections.listSocialBonds(PRIMARY_USER_ID));
    expect(outcome.outcome).toBe("retracted");
    if (outcome.outcome !== "retracted") return;
    expect(outcome.payload.store).toBe("socialBond");
    expect(outcome.payload.relationType).toBe("friend");
  });

  it("ambiguous name: asks which, never guesses", () => {
    establishSibling();
    rebuild();
    // A second, distinct entity also named "Annissa" — explicitlyNewPerson
    // forces a genuine second entity through the real resolution cascade
    // (EN-012) rather than resolving to the existing one, the same
    // duplicate-name "dangling twin" shape real accounts produce.
    const m2 = msg("Another Annissa is my colleague.");
    appendExtraction(m2.id, {
      socialBonds: [{ type: "colleague", fromName: "Annissa", toName: "me", action: "open", qualifier: null, basis: "stated", fromNameIsRoleWord: false, toNameIsRoleWord: false, explicitlyNewPerson: true }]
    });
    rebuild();
    const entities = projections.listEntities(PRIMARY_USER_ID);
    expect(entities.filter((e) => e.name === "Annissa")).toHaveLength(2);

    const outcome = resolveRelationshipRetraction(
      "Annissa",
      "me",
      "sibling_of",
      PRIMARY_USER_ID,
      entities,
      [],
      projections.listStructuralAtoms(PRIMARY_USER_ID),
      projections.listSocialBonds(PRIMARY_USER_ID)
    );
    expect(outcome.outcome).toBe("ambiguous");
    if (outcome.outcome !== "ambiguous") return;
    expect(outcome.matchNames).toEqual(["Annissa", "Annissa"]);
    expect(buildAmbiguousRetractionDirective(outcome.name, outcome.matchNames)).toMatch(/ask/);
  });

  it("a named relationship that does not exist: reports notFound, produces the directive, nothing to append", () => {
    establishSibling(); // Annissa IS a sibling — but we ask about "friend"
    rebuild();
    const entities = projections.listEntities(PRIMARY_USER_ID);
    const outcome = resolveRelationshipRetraction(
      "Annissa",
      "me",
      "friend",
      PRIMARY_USER_ID,
      entities,
      [],
      projections.listStructuralAtoms(PRIMARY_USER_ID),
      projections.listSocialBonds(PRIMARY_USER_ID)
    );
    expect(outcome).toEqual({ outcome: "notFound", firstName: "Annissa", secondName: "me", relationType: "friend" });
    expect(buildNotFoundRetractionDirective("Annissa", "me", "friend")).toContain("no such");
  });

  it("unresolvable name produces a directive naming it, never creates an entity", () => {
    const entities = projections.listEntities(PRIMARY_USER_ID);
    const outcome = resolveRelationshipRetraction("Nobody Real", "me", "sibling_of", PRIMARY_USER_ID, entities, [], [], []);
    expect(outcome).toEqual({ outcome: "unresolvable", name: "Nobody Real" });
    expect(buildUnresolvableRetractionDirective("Nobody Real")).toContain("Nobody Real");
    expect(projections.listEntities(PRIMARY_USER_ID)).toHaveLength(0);
  });
});

describe("buildRelationshipRetractedDirective", () => {
  it("confirms the specific relationship closed, by name and type", () => {
    const directive = buildRelationshipRetractedDirective({ kind: "relationshipRetraction", store: "structuralAtom", relationType: "sibling_of", targetStableKey: "01A", firstName: "Annissa", secondName: "me" });
    expect(directive).toContain("Annissa");
    expect(directive).toContain("sibling");
  });

  it("names a different relationship correctly too — not a fixed string", () => {
    const directive = buildRelationshipRetractedDirective({ kind: "relationshipRetraction", store: "socialBond", relationType: "friend", targetStableKey: "01B", firstName: "Alice", secondName: "me" });
    expect(directive).toContain("Alice");
    expect(directive).toContain("friend");
    expect(directive).not.toContain("Annissa");
    expect(directive).not.toContain("sibling");
  });

  it("the unconditional 'do not imply others were also handled' clause is present regardless of which relationship was actually closed — the function has no way to know what else the message named, so it must hold every time", () => {
    const first = buildRelationshipRetractedDirective({ kind: "relationshipRetraction", store: "structuralAtom", relationType: "sibling_of", targetStableKey: "01A", firstName: "Annissa", secondName: "me" });
    const second = buildRelationshipRetractedDirective({ kind: "relationshipRetraction", store: "socialBond", relationType: "colleague", targetStableKey: "01C", firstName: "Bob", secondName: "me" });
    for (const directive of [first, second]) {
      expect(directive).toMatch(/do NOT imply/);
      expect(directive).toMatch(/only actually updated this one/);
    }
  });
});

describe("the fold: closing, stable-key binding across rebuilds, idempotence, dossier exclusion", () => {
  it("closes a structural atom (sibling_of); the SAME row closes again by stable key on a second full rebuild; the closed relationship no longer appears in the self-profile", () => {
    establishSibling();
    rebuild();
    const atom = projections.listStructuralAtoms(PRIMARY_USER_ID)[0]!;
    expect(atom.interval_end).toBeNull();
    const key = stableKeyOf(atom)!;

    appendRetraction({ kind: "relationshipRetraction", store: "structuralAtom", relationType: "sibling_of", targetStableKey: key, firstName: "Annissa", secondName: "me" });

    const result1 = rebuild();
    expect(result1.relationshipRetractionsApplied).toBe(1);
    const closedAtom = projections.listStructuralAtoms(PRIMARY_USER_ID)[0]!;
    expect(closedAtom.interval_end).not.toBeNull();

    // Projection ids are reassigned every rebuild (EN-054) — a second full
    // rebuild must close the SAME logical row again, found by its own
    // stable key, never by the (now different) projection id.
    const result2 = rebuild();
    expect(result2.relationshipRetractionsApplied).toBe(1);
    const closedAgain = projections.listStructuralAtoms(PRIMARY_USER_ID)[0]!;
    expect(closedAgain.interval_end).not.toBeNull();
    expect(stableKeyOf(closedAgain)).toBe(key);

    const profile = buildSelfProfile(projections, PRIMARY_USER_ID);
    expect(profile.bonds.some((b) => b.name === "Annissa")).toBe(false);
  });

  it("closes a social bond (friend) the same way, and it no longer appears in the self-profile", () => {
    establishFriend();
    rebuild();
    const bond = projections.listSocialBonds(PRIMARY_USER_ID)[0]!;
    const key = stableKeyOf(bond)!;

    appendRetraction({ kind: "relationshipRetraction", store: "socialBond", relationType: "friend", targetStableKey: key, firstName: "Alice", secondName: "me" });
    rebuild();

    const closedBond = projections.listSocialBonds(PRIMARY_USER_ID)[0]!;
    expect(closedBond.interval_end).not.toBeNull();
    const profile = buildSelfProfile(projections, PRIMARY_USER_ID);
    expect(profile.bonds.some((b) => b.name === "Alice")).toBe(false);
  });

  it("idempotence: a duplicate retraction event for the same relationship is a no-op, not a second close or an error", () => {
    establishSibling();
    rebuild();
    const atom = projections.listStructuralAtoms(PRIMARY_USER_ID)[0]!;
    const key = stableKeyOf(atom)!;
    const payload: RelationshipRetractionPayload = { kind: "relationshipRetraction", store: "structuralAtom", relationType: "sibling_of", targetStableKey: key, firstName: "Annissa", secondName: "me" };
    appendRetraction(payload);
    appendRetraction(payload); // duplicate

    const result = rebuild();
    expect(result.relationshipRetractionsApplied).toBe(1); // only the first finds an OPEN row; the second finds nothing left to close
    const closed = projections.listStructuralAtoms(PRIMARY_USER_ID)[0]!;
    expect(closed.interval_end).not.toBeNull();
  });
});
