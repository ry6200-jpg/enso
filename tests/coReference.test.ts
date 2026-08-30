import { beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/events/eventLog.js";
import { ProjectionsDb } from "../src/projections/db.js";
import { primaryEntityId, rebuildProjections } from "../src/projections/rebuild.js";
import { newId } from "../src/ids.js";
import { freshTestDbPath } from "../src/test/dbPath.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";
import { findEligibleCoReferenceCandidates } from "../src/conversation/coReference.js";

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
    payload: { sourceEventId, extractorVersion: "message-v5", entities: [], structuralAtoms: [], socialBonds: [], attributes: [], ...payload },
    userId: PRIMARY_USER_ID
  });
}

function msg(text: string) {
  return eventLog.append({ type: "message_sent", actor: "user", payload: { text }, userId: PRIMARY_USER_ID });
}

function rebuild() {
  return rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);
}

function entityNamed(name: string) {
  return projections.listEntities(PRIMARY_USER_ID).filter((e) => e.name === name);
}

function appendCoReferenceConfirmation(
  placeholderStableKey: string,
  placeholderName: string,
  realStableKey: string,
  realName: string,
  anchorName: string
) {
  return eventLog.append({
    type: "fact_confirmed",
    actor: "user",
    payload: { kind: "coReference", placeholderStableKey, placeholderName, realStableKey, realName, anchorName },
    userId: PRIMARY_USER_ID
  });
}

function appendCoReferenceRetraction(targetEventId: string, placeholderStableKey: string) {
  return eventLog.append({
    type: "fact_corrected",
    actor: "user",
    payload: { kind: "coReferenceRetraction", targetEventId, placeholderStableKey },
    userId: PRIMARY_USER_ID
  });
}

function insertEntity(name: string, sourceEventIds: string[], extra: Partial<{ name_kind: "role_word" | null; owner_entity_id: string | null }> = {}) {
  const id = newId();
  projections.insertEntity({
    id,
    user_id: PRIMARY_USER_ID,
    name,
    confirmed: 0,
    source_event_ids: JSON.stringify(sourceEventIds),
    extractor_version: "message-v5",
    pending_disambiguation: null,
    created_at: new Date().toISOString(),
    ...extra
  });
  return id;
}

function insertStructuralAtom(type: "parent_of" | "spouse_of", fromId: string, toId: string) {
  projections.insertStructuralAtom({
    id: newId(),
    user_id: PRIMARY_USER_ID,
    type,
    from_entity_id: fromId,
    to_entity_id: toId,
    basis: "stated",
    interval_start: null,
    interval_end: null,
    source_event_ids: "[]",
    created_at: new Date().toISOString()
  });
}

describe("findEligibleCoReferenceCandidates: trigger firing and not firing", () => {
  it("fires when a role-word placeholder and a real name hold the SAME (type, anchor) slot, anchor live in the current message", () => {
    const annissaMsg = msg("Annissa mentioned it.");
    const annissaId = insertEntity("Annissa", [annissaMsg.id]);
    const husbandMsg = msg("her husband is not well.");
    const husbandId = insertEntity("husband", [husbandMsg.id], { name_kind: "role_word", owner_entity_id: annissaId });
    insertStructuralAtom("spouse_of", husbandId, annissaId);
    const ahSongMsg = msg("Ah Song called.");
    const ahSongId = insertEntity("Ah Song", [ahSongMsg.id]);
    insertStructuralAtom("spouse_of", ahSongId, annissaId);

    const candidates = findEligibleCoReferenceCandidates(eventLog, projections, PRIMARY_USER_ID, "Annissa mentioned Ah Song is doing better.");

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      placeholderEntityId: husbandId,
      placeholderName: "husband",
      realEntityId: ahSongId,
      realName: "Ah Song",
      anchorEntityId: annissaId,
      anchorName: "Annissa",
      relationType: "spouse_of"
    });
  });

  it("does NOT fire for two ordinary, real-named parents on one child — neither is a placeholder, nothing to suspect", () => {
    const childMsg = msg("My kid said something funny.");
    const childId = insertEntity("Jamie", [childMsg.id]);
    const motherMsg = msg("Elena is Jamie's mother.");
    const motherId = insertEntity("Elena", [motherMsg.id]);
    insertStructuralAtom("parent_of", motherId, childId);
    const fatherMsg = msg("Marcus is Jamie's father.");
    const fatherId = insertEntity("Marcus", [fatherMsg.id]);
    insertStructuralAtom("parent_of", fatherId, childId);

    const candidates = findEligibleCoReferenceCandidates(eventLog, projections, PRIMARY_USER_ID, "Jamie, Elena, and Marcus went to the park.");

    expect(candidates).toEqual([]);
  });

  it("does NOT fire when the anchor is not mentioned in the current message — the question only fires when the anchor is already live", () => {
    const annissaMsg = msg("Annissa mentioned it.");
    const annissaId = insertEntity("Annissa", [annissaMsg.id]);
    const husbandMsg = msg("her husband is not well.");
    const husbandId = insertEntity("husband", [husbandMsg.id], { name_kind: "role_word", owner_entity_id: annissaId });
    insertStructuralAtom("spouse_of", husbandId, annissaId);
    const ahSongMsg = msg("Ah Song called.");
    const ahSongId = insertEntity("Ah Song", [ahSongMsg.id]);
    insertStructuralAtom("spouse_of", ahSongId, annissaId);

    const candidates = findEligibleCoReferenceCandidates(eventLog, projections, PRIMARY_USER_ID, "just an unrelated update about my day");

    expect(candidates).toEqual([]);
  });
});

describe("co-reference merge pre-pass: folds into ONE entity across both mention orders", () => {
  it("placeholder mentioned first, real name second", () => {
    const mHusband = msg("Her husband is not well.");
    appendExtraction(mHusband.id, {
      entities: [{ name: "Annissa", type: "person" }],
      structuralAtoms: [{ type: "spouse_of", fromName: "husband", toName: "Annissa", action: "assert", fromNameIsRoleWord: true, toNameIsRoleWord: false }]
    });
    const mAhSong = msg("Ah Song is doing better now, actually.");
    appendExtraction(mAhSong.id, {
      entities: [{ name: "Ah Song", type: "person" }],
      structuralAtoms: [{ type: "spouse_of", fromName: "Ah Song", toName: "Annissa", action: "assert", fromNameIsRoleWord: false, toNameIsRoleWord: false }]
    });
    rebuild();

    appendCoReferenceConfirmation(mHusband.id, "husband", mAhSong.id, "Ah Song", "Annissa");
    rebuild();

    expect(entityNamed("husband")).toHaveLength(0);
    const merged = entityNamed("Ah Song");
    expect(merged).toHaveLength(1);
    expect(merged[0]!.name_kind ?? null).toBeNull();
    expect(merged[0]!.owner_entity_id ?? null).toBeNull();
    // The structural atom to the anchor survives, pointing at the ONE canonical id.
    const atoms = projections.listStructuralAtoms(PRIMARY_USER_ID, "spouse_of");
    const anchor = entityNamed("Annissa")[0]!;
    expect(atoms.filter((a) => a.from_entity_id === anchor.id || a.to_entity_id === anchor.id)).toHaveLength(1);
  });

  it("real name mentioned first, placeholder second — same result, order-independent", () => {
    const mAhSong = msg("I met Ah Song at the wedding, seems nice.");
    appendExtraction(mAhSong.id, { entities: [{ name: "Ah Song", type: "person" }] });
    const mAnnissa = msg("Annissa mentioned her husband is not well.");
    appendExtraction(mAnnissa.id, {
      entities: [{ name: "Annissa", type: "person" }],
      structuralAtoms: [{ type: "spouse_of", fromName: "husband", toName: "Annissa", action: "assert", fromNameIsRoleWord: true, toNameIsRoleWord: false }]
    });
    rebuild();

    appendCoReferenceConfirmation(mAnnissa.id, "husband", mAhSong.id, "Ah Song", "Annissa");
    rebuild();

    expect(entityNamed("husband")).toHaveLength(0);
    const merged = entityNamed("Ah Song");
    expect(merged).toHaveLength(1);
    expect(merged[0]!.name_kind ?? null).toBeNull();
  });

  it("the role-word string is never registered as an alias of the merged entity", () => {
    const mHusband = msg("Her husband is not well.");
    appendExtraction(mHusband.id, {
      entities: [{ name: "Annissa", type: "person" }],
      structuralAtoms: [{ type: "spouse_of", fromName: "husband", toName: "Annissa", action: "assert", fromNameIsRoleWord: true, toNameIsRoleWord: false }]
    });
    const mAhSong = msg("Ah Song is doing better now.");
    appendExtraction(mAhSong.id, {
      structuralAtoms: [{ type: "spouse_of", fromName: "Ah Song", toName: "Annissa", action: "assert", fromNameIsRoleWord: false, toNameIsRoleWord: false }]
    });
    rebuild();
    appendCoReferenceConfirmation(mHusband.id, "husband", mAhSong.id, "Ah Song", "Annissa");
    rebuild();

    expect(projections.findEntityIdByExactAlias(PRIMARY_USER_ID, "husband")).toBeUndefined();
    const merged = entityNamed("Ah Song")[0]!;
    expect(projections.findEntityIdByExactAlias(PRIMARY_USER_ID, "Ah Song")).toBe(merged.id);
  });
});

describe("retraction: splits the merged entity back apart deterministically", () => {
  it("a retraction targeting the confirmation's own event ULID reverses the merge on the next rebuild", () => {
    const mHusband = msg("Her husband is not well.");
    appendExtraction(mHusband.id, {
      entities: [{ name: "Annissa", type: "person" }],
      structuralAtoms: [{ type: "spouse_of", fromName: "husband", toName: "Annissa", action: "assert", fromNameIsRoleWord: true, toNameIsRoleWord: false }]
    });
    const mAhSong = msg("Ah Song is doing better now.");
    appendExtraction(mAhSong.id, {
      entities: [{ name: "Ah Song", type: "person" }],
      structuralAtoms: [{ type: "spouse_of", fromName: "Ah Song", toName: "Annissa", action: "assert", fromNameIsRoleWord: false, toNameIsRoleWord: false }]
    });
    rebuild();

    const confirmationEvent = appendCoReferenceConfirmation(mHusband.id, "husband", mAhSong.id, "Ah Song", "Annissa");
    rebuild();
    expect(entityNamed("husband")).toHaveLength(0);
    expect(entityNamed("Ah Song")).toHaveLength(1);

    appendCoReferenceRetraction(confirmationEvent.id, mHusband.id);
    rebuild();

    const husbandAfterRetraction = entityNamed("husband");
    const ahSongAfterRetraction = entityNamed("Ah Song");
    expect(husbandAfterRetraction).toHaveLength(1);
    expect(husbandAfterRetraction[0]!.name_kind).toBe("role_word");
    expect(ahSongAfterRetraction).toHaveLength(1);
    expect(ahSongAfterRetraction[0]!.name_kind ?? null).toBeNull();
  });

  it("a mention that arrives AFTER the retraction still folds in normally against the (now split) placeholder", () => {
    const mHusband = msg("Her husband is not well.");
    appendExtraction(mHusband.id, {
      entities: [{ name: "Annissa", type: "person" }],
      structuralAtoms: [{ type: "spouse_of", fromName: "husband", toName: "Annissa", action: "assert", fromNameIsRoleWord: true, toNameIsRoleWord: false }]
    });
    const mAhSong = msg("Ah Song is doing better now.");
    appendExtraction(mAhSong.id, {
      entities: [{ name: "Ah Song", type: "person" }],
      structuralAtoms: [{ type: "spouse_of", fromName: "Ah Song", toName: "Annissa", action: "assert", fromNameIsRoleWord: false, toNameIsRoleWord: false }]
    });
    const confirmationEvent = appendCoReferenceConfirmation(mHusband.id, "husband", mAhSong.id, "Ah Song", "Annissa");
    appendCoReferenceRetraction(confirmationEvent.id, mHusband.id);

    const mHusbandAgain = msg("Her husband is doing a bit better.");
    appendExtraction(mHusbandAgain.id, {
      structuralAtoms: [{ type: "spouse_of", fromName: "husband", toName: "Annissa", action: "assert", fromNameIsRoleWord: true, toNameIsRoleWord: false }]
    });
    rebuild();

    // Still split: the later "husband" mention reuses the SAME (post-retraction) placeholder entity, not a third one.
    expect(entityNamed("husband")).toHaveLength(1);
    expect(entityNamed("Ah Song")).toHaveLength(1);
  });
});

describe("discriminator: the existing fact_confirmed/fact_corrected handlers never touch a co-reference payload, and vice versa", () => {
  it("an ordinary fact_confirmed (attribute-style) event is unaffected by the coReference guard", () => {
    const m = msg("I live in Seattle.");
    const extraction = appendExtraction(m.id, { entities: [{ name: "Marcus", type: "person" }] });
    // targetEventId binds to the extraction_completed event's own ULID
    // (EN-055) — NOT the message event's id, since mentionResolution's
    // per-event cache key is keyed on the extraction event's id.
    eventLog.append({ type: "fact_confirmed", actor: "user", payload: { targetEventId: extraction.id, entityName: "Marcus" }, userId: PRIMARY_USER_ID });
    const result = rebuild();

    expect(result.confirmationsApplied).toBe(1);
    expect(entityNamed("Marcus")[0]?.confirmed).toBe(1);
  });

  it("a coReference-kind fact_confirmed event does NOT increment confirmationsApplied — it is handled entirely by the pre-pass, not the existing post-loop handler", () => {
    const mHusband = msg("Her husband is not well.");
    appendExtraction(mHusband.id, {
      entities: [{ name: "Annissa", type: "person" }],
      structuralAtoms: [{ type: "spouse_of", fromName: "husband", toName: "Annissa", action: "assert", fromNameIsRoleWord: true, toNameIsRoleWord: false }]
    });
    const mAhSong = msg("Ah Song is doing better now.");
    appendExtraction(mAhSong.id, {
      entities: [{ name: "Ah Song", type: "person" }],
      structuralAtoms: [{ type: "spouse_of", fromName: "Ah Song", toName: "Annissa", action: "assert", fromNameIsRoleWord: false, toNameIsRoleWord: false }]
    });
    rebuild();

    appendCoReferenceConfirmation(mHusband.id, "husband", mAhSong.id, "Ah Song", "Annissa");
    const result = rebuild();

    expect(result.confirmationsApplied).toBe(0);
  });

  it("a coReferenceRetraction-kind fact_corrected event does NOT increment correctionsApplied/attributeCorrectionsApplied — it is handled entirely by the pre-pass", () => {
    const mHusband = msg("Her husband is not well.");
    appendExtraction(mHusband.id, {
      entities: [{ name: "Annissa", type: "person" }],
      structuralAtoms: [{ type: "spouse_of", fromName: "husband", toName: "Annissa", action: "assert", fromNameIsRoleWord: true, toNameIsRoleWord: false }]
    });
    const mAhSong = msg("Ah Song is doing better now.");
    appendExtraction(mAhSong.id, {
      entities: [{ name: "Ah Song", type: "person" }],
      structuralAtoms: [{ type: "spouse_of", fromName: "Ah Song", toName: "Annissa", action: "assert", fromNameIsRoleWord: false, toNameIsRoleWord: false }]
    });
    rebuild();
    const confirmationEvent = appendCoReferenceConfirmation(mHusband.id, "husband", mAhSong.id, "Ah Song", "Annissa");
    rebuild();

    appendCoReferenceRetraction(confirmationEvent.id, mHusband.id);
    const result = rebuild();

    expect(result.correctionsApplied).toBe(0);
    expect(result.attributeCorrectionsApplied).toBe(0);
  });

  it("an ordinary entity-name fact_corrected event is unaffected by the coReferenceRetraction guard", () => {
    const m = msg("I met someone named Marc.");
    const extraction = appendExtraction(m.id, { entities: [{ name: "Marc", type: "person" }] });
    rebuild();

    eventLog.append({ type: "fact_corrected", actor: "user", payload: { targetEventId: extraction.id, entityName: "Marc", correctedName: "Marcus" }, userId: PRIMARY_USER_ID });
    const result = rebuild();

    expect(result.correctionsApplied).toBe(1);
    expect(entityNamed("Marcus")).toHaveLength(1);
  });
});

describe("crash guard: a co-reference payload reaching the existing handler must not throw entityName.trim()-on-undefined", () => {
  it("rebuild does not throw when a coReference fact_confirmed payload (no entityName at all) exists in the log", () => {
    const mHusband = msg("Her husband is not well.");
    appendExtraction(mHusband.id, {
      entities: [{ name: "Annissa", type: "person" }],
      structuralAtoms: [{ type: "spouse_of", fromName: "husband", toName: "Annissa", action: "assert", fromNameIsRoleWord: true, toNameIsRoleWord: false }]
    });
    const mAhSong = msg("Ah Song is doing better now.");
    appendExtraction(mAhSong.id, {
      entities: [{ name: "Ah Song", type: "person" }],
      structuralAtoms: [{ type: "spouse_of", fromName: "Ah Song", toName: "Annissa", action: "assert", fromNameIsRoleWord: false, toNameIsRoleWord: false }]
    });
    // No entityName field anywhere on this payload — the exact shape that
    // would throw on payload.entityName.trim() if the existing handler
    // ever processed it unguarded.
    eventLog.append({
      type: "fact_confirmed",
      actor: "user",
      payload: { kind: "coReference", placeholderStableKey: mHusband.id, placeholderName: "husband", realStableKey: mAhSong.id, realName: "Ah Song", anchorName: "Annissa" },
      userId: PRIMARY_USER_ID
    });

    expect(() => rebuild()).not.toThrow();
  });

  it("rebuild does not throw when a coReferenceRetraction fact_corrected payload (no entityName at all) exists in the log", () => {
    const mHusband = msg("Her husband is not well.");
    appendExtraction(mHusband.id, {
      structuralAtoms: [{ type: "spouse_of", fromName: "husband", toName: "me", action: "assert", fromNameIsRoleWord: true, toNameIsRoleWord: false }]
    });
    // No entityName field, and targetEventId points at a made-up event id —
    // the retraction guard must skip this before resolveCorrectionTargetEntity
    // is ever called with an undefined entityName.
    eventLog.append({
      type: "fact_corrected",
      actor: "user",
      payload: { kind: "coReferenceRetraction", targetEventId: "not-a-real-confirmation-event", placeholderStableKey: mHusband.id },
      userId: PRIMARY_USER_ID
    });

    expect(() => rebuild()).not.toThrow();
  });
});
