import { beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/events/eventLog.js";
import { ProjectionsDb } from "../src/projections/db.js";
import { rebuildProjections } from "../src/projections/rebuild.js";
import { freshTestDbPath } from "../src/test/dbPath.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";

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

function rebuild(referenceDate: Date) {
  return rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID, undefined, referenceDate);
}

// EventLog.append always stamps recordedAt with the real, actual current
// time (append-only discipline — never spoofable) — so "N days ago" is
// simulated by moving referenceDate FORWARD from real "now" by N days,
// never by trying to backdate the event itself.
function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

describe("unnamed-entity purge (30-day rule)", () => {
  it("purges an unnamed entity 30+ days past its last mention, cascading atoms, bonds, attributes, and aliases", () => {
    // "husband" here is the extraction-FAULT shape confirmed on the real
    // corpus: fromNameIsRoleWord: false, so it resolves via the ORDINARY
    // name path (name_kind stays null) rather than resolveRoleWordName —
    // which is also what lets it pick up a real alias row, giving one
    // entity that exercises all four cascade targets at once.
    const m1 = msg("My husband is around.");
    appendExtraction(m1.id, {
      structuralAtoms: [{ type: "spouse_of", fromName: "husband", toName: "me", action: "assert", fromNameIsRoleWord: false, toNameIsRoleWord: false }],
      attributes: [{ entityName: "husband", attribute: "gender", value: "male" }]
    });
    const m2 = msg("My husband is also my colleague, oddly enough.");
    appendExtraction(m2.id, {
      socialBonds: [{ type: "colleague", fromName: "husband", toName: "me", action: "open", qualifier: null, basis: "stated", fromNameIsRoleWord: false, toNameIsRoleWord: false }]
    });

    rebuild(daysFromNow(0));
    const before = projections.listEntities(PRIMARY_USER_ID).find((e) => e.name === "husband")!;
    expect(before.name_kind ?? null).toBeNull(); // the extraction-fault shape, not role_word
    expect(projections.findEntityIdByExactAlias(PRIMARY_USER_ID, "husband")).toBe(before.id);
    expect(projections.listStructuralAtoms(PRIMARY_USER_ID).some((a) => a.from_entity_id === before.id || a.to_entity_id === before.id)).toBe(true);
    expect(projections.listSocialBonds(PRIMARY_USER_ID).some((b) => b.from_entity_id === before.id || b.to_entity_id === before.id)).toBe(true);
    expect(projections.listAllEntityAttributes(PRIMARY_USER_ID).some((a) => a.entity_id === before.id)).toBe(true);

    const result = rebuild(daysFromNow(31));

    expect(result.entitiesPurged).toBe(1);
    expect(projections.listEntities(PRIMARY_USER_ID).find((e) => e.name === "husband")).toBeUndefined();
    expect(projections.findEntityIdByExactAlias(PRIMARY_USER_ID, "husband")).toBeUndefined();
    expect(projections.listStructuralAtoms(PRIMARY_USER_ID).some((a) => a.from_entity_id === before.id || a.to_entity_id === before.id)).toBe(false);
    expect(projections.listSocialBonds(PRIMARY_USER_ID).some((b) => b.from_entity_id === before.id || b.to_entity_id === before.id)).toBe(false);
    expect(projections.listAllEntityAttributes(PRIMARY_USER_ID).some((a) => a.entity_id === before.id)).toBe(false);
  });

  it("keeps an unnamed entity at 29 days — not yet eligible", () => {
    const m1 = msg("Her mother called.");
    appendExtraction(m1.id, {
      structuralAtoms: [{ type: "parent_of", fromName: "mother", toName: "me", action: "assert", fromNameIsRoleWord: true, toNameIsRoleWord: false }]
    });
    rebuild(daysFromNow(0));
    expect(projections.listEntities(PRIMARY_USER_ID).find((e) => e.name === "mother")).toBeDefined();

    const result = rebuild(daysFromNow(29));

    expect(result.entitiesPurged).toBe(0);
    expect(projections.listEntities(PRIMARY_USER_ID).find((e) => e.name === "mother")).toBeDefined();
  });

  it("catches a name_kind-null entity via the word list — the exact extraction-fault shape confirmed on the real corpus", () => {
    const m1 = msg("She called again today.");
    appendExtraction(m1.id, { entities: [{ name: "she", type: "person" }] });
    rebuild(daysFromNow(0));
    const she = projections.listEntities(PRIMARY_USER_ID).find((e) => e.name === "she")!;
    expect(she.name_kind ?? null).toBeNull();

    const result = rebuild(daysFromNow(31));

    expect(result.entitiesPurged).toBe(1);
    expect(projections.listEntities(PRIMARY_USER_ID).find((e) => e.name === "she")).toBeUndefined();
  });

  it("never purges a real name that merely CONTAINS a role word as a substring — exact match only", () => {
    const m1 = msg("Sister Mary stopped by the house.");
    appendExtraction(m1.id, { entities: [{ name: "Sister Mary", type: "person" }] });
    rebuild(daysFromNow(0));
    expect(projections.listEntities(PRIMARY_USER_ID).find((e) => e.name === "Sister Mary")).toBeDefined();

    const result = rebuild(daysFromNow(365));

    expect(result.entitiesPurged).toBe(0);
    expect(projections.listEntities(PRIMARY_USER_ID).find((e) => e.name === "Sister Mary")).toBeDefined();
  });

  it("never purges a merged entity that now carries a real name, regardless of age", () => {
    const m1 = msg("Her father called again today, just to check in.");
    appendExtraction(m1.id, {
      entities: [{ name: "Vanessa", type: "person" }],
      structuralAtoms: [{ type: "parent_of", fromName: "father", toName: "Vanessa", action: "assert", fromNameIsRoleWord: true, toNameIsRoleWord: false }]
    });
    const m2 = msg("An Song is doing better now.");
    appendExtraction(m2.id, {
      structuralAtoms: [{ type: "parent_of", fromName: "An Song", toName: "Vanessa", action: "assert", fromNameIsRoleWord: false, toNameIsRoleWord: false }]
    });
    rebuild(daysFromNow(0));

    const fatherStableKey = m1.id; // stableKeyOf = earliest sorted source_event_ids entry = this message's own id
    const anSongStableKey = m2.id;
    eventLog.append({
      type: "fact_confirmed",
      actor: "user",
      payload: { kind: "coReference", placeholderStableKey: fatherStableKey, placeholderName: "father", realStableKey: anSongStableKey, realName: "An Song", anchorName: "Vanessa", aliasSuppressed: false },
      userId: PRIMARY_USER_ID
    });

    const result = rebuild(daysFromNow(1000)); // far past any threshold

    expect(result.entitiesPurged).toBe(0);
    const merged = projections.listEntities(PRIMARY_USER_ID).find((e) => e.name === "An Song");
    expect(merged).toBeDefined();
    expect(merged!.name_kind ?? null).toBeNull(); // a real, ordinary entity now — never role_word
    expect(projections.listEntities(PRIMARY_USER_ID).find((e) => e.name === "father")).toBeUndefined(); // folded in, not a separate surviving row
  });

  it("an unnamed entity with only a role-word alias is still purged — the alias itself being a role word doesn't count as a real name learned", () => {
    const m1 = msg("She called again today.");
    appendExtraction(m1.id, { entities: [{ name: "she", type: "person" }] });
    rebuild(daysFromNow(0));
    const she = projections.listEntities(PRIMARY_USER_ID).find((e) => e.name === "she")!;
    // Confirmed real-corpus shape: createEntity self-registers the
    // entity's own (role-word) text as its own first alias.
    expect(projections.findEntityIdByExactAlias(PRIMARY_USER_ID, "she")).toBe(she.id);

    const result = rebuild(daysFromNow(31));

    expect(result.entitiesPurged).toBe(1);
    expect(projections.listEntities(PRIMARY_USER_ID).find((e) => e.name === "she")).toBeUndefined();
  });

  it("an unnamed entity that has also picked up a genuine, non-role-word alias is exempt regardless of age", () => {
    // Deliberately isolates the ALIAS exemption from the NAME-field
    // exemption the merge test above already covers: here the entity's
    // OWN name/name_kind still reads as unnamed ("husband", list-matched)
    // — only a coReference merge (aliasSuppressed: false) attaching a
    // genuine real name as an alias is what must exempt it.
    const m1 = msg("My husband is around.");
    appendExtraction(m1.id, {
      structuralAtoms: [{ type: "spouse_of", fromName: "husband", toName: "me", action: "assert", fromNameIsRoleWord: false, toNameIsRoleWord: false }]
    });
    const m2 = msg("Marcus stopped by too.");
    appendExtraction(m2.id, { entities: [{ name: "Marcus", type: "person" }] });
    rebuild(daysFromNow(0));

    eventLog.append({
      type: "fact_confirmed",
      actor: "user",
      payload: { kind: "coReference", placeholderStableKey: m2.id, placeholderName: "Marcus", realStableKey: m1.id, realName: "husband", anchorName: "", aliasSuppressed: false },
      userId: PRIMARY_USER_ID
    });

    const result = rebuild(daysFromNow(1000));

    expect(result.entitiesPurged).toBe(0);
    const entity = projections.listEntities(PRIMARY_USER_ID).find((e) => e.name === "husband");
    expect(entity).toBeDefined();
    expect(projections.findEntityIdByExactAlias(PRIMARY_USER_ID, "Marcus")).toBe(entity!.id);
  });

  it("two rebuilds with the same referenceDate produce identical results (EN-057)", () => {
    const m1 = msg("Her mother called.");
    appendExtraction(m1.id, {
      structuralAtoms: [{ type: "parent_of", fromName: "mother", toName: "me", action: "assert", fromNameIsRoleWord: true, toNameIsRoleWord: false }]
    });
    const allEvents = eventLog.listForUser(PRIMARY_USER_ID);
    const referenceDate = daysFromNow(31);

    const runA = new ProjectionsDb(freshTestDbPath(import.meta.url, "run-a"));
    const runB = new ProjectionsDb(freshTestDbPath(import.meta.url, "run-b"));
    const resultA = rebuildProjections(allEvents, runA, PRIMARY_USER_ID, undefined, referenceDate);
    const resultB = rebuildProjections(allEvents, runB, PRIMARY_USER_ID, undefined, referenceDate);

    expect(resultA.entitiesPurged).toBe(resultB.entitiesPurged);
    expect(runA.listEntities(PRIMARY_USER_ID).map((e) => e.name).sort()).toEqual(runB.listEntities(PRIMARY_USER_ID).map((e) => e.name).sort());
  });

  it("the same log with different referenceDates produces different results", () => {
    const m1 = msg("Her mother called.");
    appendExtraction(m1.id, {
      structuralAtoms: [{ type: "parent_of", fromName: "mother", toName: "me", action: "assert", fromNameIsRoleWord: true, toNameIsRoleWord: false }]
    });
    const allEvents = eventLog.listForUser(PRIMARY_USER_ID);

    const runEarly = new ProjectionsDb(freshTestDbPath(import.meta.url, "run-early"));
    const runLate = new ProjectionsDb(freshTestDbPath(import.meta.url, "run-late"));
    const resultEarly = rebuildProjections(allEvents, runEarly, PRIMARY_USER_ID, undefined, daysFromNow(0));
    const resultLate = rebuildProjections(allEvents, runLate, PRIMARY_USER_ID, undefined, daysFromNow(31));

    expect(resultEarly.entitiesPurged).toBe(0);
    expect(resultLate.entitiesPurged).toBe(1);
    expect(runEarly.listEntities(PRIMARY_USER_ID).find((e) => e.name === "mother")).toBeDefined();
    expect(runLate.listEntities(PRIMARY_USER_ID).find((e) => e.name === "mother")).toBeUndefined();
  });
});
