import { beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/events/eventLog.js";
import { ProjectionsDb } from "../src/projections/db.js";
import { rebuildProjections } from "../src/projections/rebuild.js";
import { resolveEntityAttribute } from "../src/perception/attributes.js";
import { freshTestDbPath } from "../src/test/dbPath.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";

let eventLog: EventLog;
let projections: ProjectionsDb;

beforeEach(() => {
  eventLog = new EventLog(freshTestDbPath(import.meta.url, "events"));
  projections = new ProjectionsDb(freshTestDbPath(import.meta.url, "projections"));
});

function msg(text: string) {
  return eventLog.append({ type: "message_sent", actor: "user", payload: { text }, userId: PRIMARY_USER_ID });
}

function appendExtraction(sourceEventId: string, payload: Record<string, unknown>) {
  return eventLog.append({
    type: "extraction_completed",
    actor: "system",
    payload: { sourceEventId, extractorVersion: "message-v5", kind: "message", entities: [], structuralAtoms: [], socialBonds: [], attributes: [], ...payload },
    userId: PRIMARY_USER_ID
  });
}

function appendCoReferenceConfirmation(placeholderStableKey: string, placeholderName: string, realStableKey: string, realName: string, anchorName: string) {
  return eventLog.append({
    type: "fact_confirmed",
    actor: "user",
    payload: { kind: "coReference", placeholderStableKey, placeholderName, realStableKey, realName, anchorName },
    userId: PRIMARY_USER_ID
  });
}

function rebuild() {
  return rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);
}

function entityNamed(name: string) {
  return projections.listEntities(PRIMARY_USER_ID).filter((e) => e.name === name);
}

describe("role-word gender derivation: a merge carries the derived gender to the canonical entity", () => {
  it("gender derived on the placeholder ('father', male) lands on the canonical entity ('An Song') once the merge confirmation exists", () => {
    const mFather = msg("Her father drove her to the airport last week.");
    appendExtraction(mFather.id, {
      entities: [{ name: "Vanessa", type: "person" }],
      structuralAtoms: [{ type: "parent_of", fromName: "father", toName: "Vanessa", action: "assert", fromNameIsRoleWord: true, toNameIsRoleWord: false }]
    });
    const mAnSong = msg("Vanessa's dad is An Song.");
    appendExtraction(mAnSong.id, {
      entities: [{ name: "An Song", type: "person" }],
      structuralAtoms: [{ type: "parent_of", fromName: "An Song", toName: "Vanessa", action: "assert", fromNameIsRoleWord: false, toNameIsRoleWord: false }]
    });
    rebuild();

    // Before any merge: gender was derived onto the PLACEHOLDER, not An Song.
    const placeholderBefore = entityNamed("father")[0]!;
    expect(resolveEntityAttribute(projections, PRIMARY_USER_ID, placeholderBefore.id, "gender")?.value).toBe("male");
    const anSongBefore = entityNamed("An Song")[0]!;
    expect(resolveEntityAttribute(projections, PRIMARY_USER_ID, anSongBefore.id, "gender")).toBeNull();

    appendCoReferenceConfirmation(mFather.id, "father", mAnSong.id, "An Song", "Vanessa");
    rebuild();

    expect(entityNamed("father")).toHaveLength(0); // placeholder never independently created in a replay with the confirmation present
    const merged = entityNamed("An Song");
    expect(merged).toHaveLength(1);
    const resolved = resolveEntityAttribute(projections, PRIMARY_USER_ID, merged[0]!.id, "gender");
    expect(resolved?.value).toBe("male");
    expect(resolved?.row.provenance_kind).toBe("inferred");
  });
});

// NOTE on how these two parents get their gender: a "stated" gender
// (extraction's `attributes` array) is NEVER visible to role-word
// disambiguation within the same rebuild — confirmed by direct testing,
// documented on findGenderDisambiguationMatch's own comment in rebuild.ts.
// structuralAtoms/socialBonds/entities process in rebuild's FIRST full
// pass over the event log; `attributes` processes in a SEPARATE, LATER
// pass that hasn't run for ANY event while the first pass is still in
// progress. So both of Vanessa's parents here get named AND gendered the
// only way that's actually visible in time: a role-word mention, merged
// via a real co-reference confirmation — the same mechanism the first
// describe block above already verified in isolation.
describe("role-word gender disambiguation: a bare role word resolves to the matching real parent, not a new placeholder", () => {
  function establishGenderedParent(placeholderWord: string, childMsgText: string, realName: string, realMsgText: string) {
    const mPlaceholder = msg(childMsgText);
    appendExtraction(mPlaceholder.id, {
      entities: [{ name: "Vanessa", type: "person" }],
      structuralAtoms: [{ type: "parent_of", fromName: placeholderWord, toName: "Vanessa", action: "assert", fromNameIsRoleWord: true, toNameIsRoleWord: false }]
    });
    const mReal = msg(realMsgText);
    appendExtraction(mReal.id, {
      entities: [{ name: realName, type: "person" }],
      structuralAtoms: [{ type: "parent_of", fromName: realName, toName: "Vanessa", action: "assert", fromNameIsRoleWord: false, toNameIsRoleWord: false }]
    });
    appendCoReferenceConfirmation(mPlaceholder.id, placeholderWord, mReal.id, realName, "Vanessa");
  }

  it("'father' resolves to the already-established male parent (An Song) when the owner has two real, gendered parents on record", () => {
    establishGenderedParent("father", "Her father drove her to the airport.", "An Song", "Vanessa's dad is An Song.");
    establishGenderedParent("mother", "Her mother works nearby.", "Alice", "Vanessa's mom is Alice.");
    rebuild();

    const anSong = entityNamed("An Song")[0]!;
    const alice = entityNamed("Alice")[0]!;
    expect(resolveEntityAttribute(projections, PRIMARY_USER_ID, anSong.id, "gender")?.value).toBe("male");
    expect(resolveEntityAttribute(projections, PRIMARY_USER_ID, alice.id, "gender")?.value).toBe("female");
    expect(projections.listStructuralAtoms(PRIMARY_USER_ID, "parent_of")).toHaveLength(2);

    const mLater = msg("Her father called again today.");
    appendExtraction(mLater.id, {
      structuralAtoms: [{ type: "parent_of", fromName: "father", toName: "Vanessa", action: "assert", fromNameIsRoleWord: true, toNameIsRoleWord: false }]
    });
    rebuild();

    expect(entityNamed("father")).toHaveLength(0); // no new placeholder created
    expect(projections.listStructuralAtoms(PRIMARY_USER_ID, "parent_of")).toHaveLength(2); // resolved to the EXISTING An Song<->Vanessa atom, no third
    // Entity ids are reassigned on every rebuild (EN-054) — re-fetch after
    // the second rebuild rather than reusing the pre-rebuild anSong.id.
    const vanessaAfter = entityNamed("Vanessa")[0]!;
    const anSongAfter = entityNamed("An Song")[0]!;
    const fatherAtom = projections
      .listStructuralAtoms(PRIMARY_USER_ID, "parent_of")
      .find((a) => a.to_entity_id === vanessaAfter.id && a.from_entity_id === anSongAfter.id);
    expect(fatherAtom).toBeDefined();
  });

  it("falls back to placeholder creation when BOTH established parents share the implied gender (ambiguous — zero or multiple matches never guessed)", () => {
    establishGenderedParent("mother", "Her mother drove her to the airport.", "Alice", "Vanessa's mom is Alice.");
    establishGenderedParent("mother", "Her mom sang to her at bedtime.", "Elena", "Vanessa's other mom is Elena.");
    rebuild();

    const mLater = msg("Her mother called again today.");
    appendExtraction(mLater.id, {
      structuralAtoms: [{ type: "parent_of", fromName: "mother", toName: "Vanessa", action: "assert", fromNameIsRoleWord: true, toNameIsRoleWord: false }]
    });
    rebuild();

    expect(entityNamed("mother")).toHaveLength(1); // ambiguous (both Alice and Elena are female) — a NEW placeholder is created, nothing guessed
    expect(projections.listStructuralAtoms(PRIMARY_USER_ID, "parent_of")).toHaveLength(3);
  });

  it("post-merge re-mention, spouse_of: 'Alice's husband' resolves to the already-merged An Song, bypassing the merge record entirely (spouse_of is symmetric, unlike parent_of above)", () => {
    const mHusband = msg("Alice mentioned her husband is not well.");
    appendExtraction(mHusband.id, {
      entities: [{ name: "Alice", type: "person" }],
      structuralAtoms: [{ type: "spouse_of", fromName: "husband", toName: "Alice", action: "assert", fromNameIsRoleWord: true, toNameIsRoleWord: false }]
    });
    const mAnSong = msg("Alice's husband is An Song.");
    appendExtraction(mAnSong.id, {
      entities: [{ name: "An Song", type: "person" }],
      structuralAtoms: [{ type: "spouse_of", fromName: "An Song", toName: "Alice", action: "assert", fromNameIsRoleWord: false, toNameIsRoleWord: false }]
    });
    appendCoReferenceConfirmation(mHusband.id, "husband", mAnSong.id, "An Song", "Alice");
    rebuild();

    const anSongBefore = entityNamed("An Song")[0]!;
    expect(resolveEntityAttribute(projections, PRIMARY_USER_ID, anSongBefore.id, "gender")?.value).toBe("male");
    expect(entityNamed("husband")).toHaveLength(0); // merged, same as the parent_of case above

    // A genuinely NEW message, sharing no ids with mHusband/mAnSong — the
    // same post-merge re-mention shape as the parent_of test above.
    // resolveCoReferenceMerge is keyed on mHusband.id/mAnSong.id and will
    // fail to match THIS message's own source-event ids; disambiguation is
    // what has to resolve it, or it doesn't resolve at all.
    const mLater = msg("Her husband called again today.");
    appendExtraction(mLater.id, {
      structuralAtoms: [{ type: "spouse_of", fromName: "husband", toName: "Alice", action: "assert", fromNameIsRoleWord: true, toNameIsRoleWord: false }]
    });
    rebuild();

    expect(entityNamed("husband")).toHaveLength(0); // no new placeholder created
    expect(projections.listStructuralAtoms(PRIMARY_USER_ID, "spouse_of")).toHaveLength(1); // resolved onto the EXISTING An Song<->Alice atom, no second

    const aliceAfter = entityNamed("Alice")[0]!;
    const anSongAfter = entityNamed("An Song")[0]!;
    const husbandAtom = projections
      .listStructuralAtoms(PRIMARY_USER_ID, "spouse_of")
      .find(
        (a) =>
          (a.from_entity_id === anSongAfter.id && a.to_entity_id === aliceAfter.id) ||
          (a.from_entity_id === aliceAfter.id && a.to_entity_id === anSongAfter.id)
      );
    expect(husbandAtom).toBeDefined();
  });
});
