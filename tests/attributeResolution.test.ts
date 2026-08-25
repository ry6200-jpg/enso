import { beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/events/eventLog.js";
import { ProjectionsDb } from "../src/projections/db.js";
import { primaryEntityId, rebuildProjections } from "../src/projections/rebuild.js";
import { assertAttribute, getCurrentAttribute, resolveAttribute, resolveEntityAttribute, type ResolvedAttribute } from "../src/perception/attributes.js";
import { getPrimaryUserBirthdate, getPrimaryUserAttribute } from "../src/projections/peopleView.js";
import { getChineseZodiacSign, getWesternZodiacSign } from "../src/zodiac/zodiac.js";
import type { EntityAttributeRow } from "../src/projections/db.js";
import { freshTestDbPath } from "../src/test/dbPath.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";

function row(id: string, attribute: EntityAttributeRow["attribute"], value: string): EntityAttributeRow {
  return { id, user_id: PRIMARY_USER_ID, entity_id: primaryEntityId(PRIMARY_USER_ID), attribute, value, source_event_ids: "[]", created_at: "2026-01-01T00:00:00.000Z" };
}

describe("resolveAttribute — pure function (R36/R37: mutability, not format, is the real distinction)", () => {
  it("returns null for empty history", () => {
    expect(resolveAttribute([])).toBeNull();
  });

  it("immutable (birthdate): first valid value wins, later different value is flagged as a conflict, never silently discarded", () => {
    const history = [row("a", "birthdate", "1970-04-24"), row("b", "birthdate", "1983")];
    const resolved = resolveAttribute(history)!;
    expect(resolved.value).toBe("1970-04-24");
    expect(resolved.conflicting.map((r) => r.value)).toEqual(["1983"]);
  });

  it("immutable (birthdate): a later assertion of the SAME value is not a conflict", () => {
    const history = [row("a", "birthdate", "1970-04-24"), row("b", "birthdate", "1970-04-24")];
    const resolved = resolveAttribute(history)!;
    expect(resolved.value).toBe("1970-04-24");
    expect(resolved.conflicting).toEqual([]);
  });

  it("immutable (birthdate): skips a malformed FIRST value and resolves to the first VALID one", () => {
    const history = [row("a", "birthdate", "not a date"), row("b", "birthdate", "1970-04-24")];
    const resolved = resolveAttribute(history)!;
    expect(resolved.value).toBe("1970-04-24");
    expect(resolved.row.id).toBe("b");
  });

  it("immutable (birthdate): returns null when every asserted value is malformed", () => {
    const history = [row("a", "birthdate", "1983"), row("b", "birthdate", "not a date")];
    expect(resolveAttribute(history)).toBeNull();
  });

  it("accepts the US M/D/YYYY form as valid, same as zodiac.ts's parser", () => {
    const history = [row("a", "birthdate", "4/24/1970")];
    expect(resolveAttribute(history)!.value).toBe("4/24/1970");
  });

  it("accepts a spelled-out month name, same as zodiac.ts's parser (R38 follow-up, found live: extraction stores a birthdate 'as literally asserted' and a prose sentence produces prose, not ISO)", () => {
    const history = [row("a", "birthdate", "April 24, 1970")];
    expect(resolveAttribute(history)!.value).toBe("April 24, 1970");
  });

  it("mutable (location): latest wins, never flagged as a conflict — a real update, not an error", () => {
    const history = [row("a", "location", "Austin"), row("b", "location", "Seattle")];
    const resolved = resolveAttribute(history)!;
    expect(resolved.value).toBe("Seattle");
    expect(resolved.conflicting).toEqual([]);
  });

  it("mutable (occupation): latest wins, no format validation applied (free text)", () => {
    const history = [row("a", "occupation", "anything at all"), row("b", "occupation", "still anything")];
    expect(resolveAttribute(history)!.value).toBe("still anything");
  });

  it("mutable (gender/sexual_orientation/life_stage, EN-114): latest wins, never flagged as a conflict — same model as occupation, deliberately NOT birthdate's immutable model", () => {
    for (const attribute of ["gender", "sexual_orientation", "life_stage"] as const) {
      const history = [row("a", attribute, "first stated value"), row("b", attribute, "a later clarification")];
      const resolved = resolveAttribute(history)!;
      expect(resolved.value).toBe("a later clarification");
      expect(resolved.conflicting).toEqual([]);
    }
  });
});

describe("resolveEntityAttribute / getCurrentAttribute — same resolver, DB-backed", () => {
  let projections: ProjectionsDb;

  beforeEach(() => {
    projections = new ProjectionsDb(freshTestDbPath(import.meta.url, "projections"));
  });

  it("getCurrentAttribute now agrees with resolveAttribute for an immutable conflict, closing the two-implementations-that-can-disagree gap", () => {
    const entityId = "third-party-1";
    const thirdPartyRow = (id: string, value: string): EntityAttributeRow => ({ ...row(id, "birthdate", value), entity_id: entityId });
    projections.insertEntityAttribute(thirdPartyRow("a", "1990-05-12"));
    projections.insertEntityAttribute(thirdPartyRow("b", "1991"));

    const viaResolver = resolveEntityAttribute(projections, PRIMARY_USER_ID, entityId, "birthdate")!;
    const viaGetCurrent = getCurrentAttribute(projections, PRIMARY_USER_ID, entityId, "birthdate")!;
    expect(viaGetCurrent.value).toBe(viaResolver.value);
    expect(viaGetCurrent.value).toBe("1990-05-12"); // first valid wins, even for a third party — a birthdate can't change for anyone
  });
});

describe("real-failure replay: the exact dev-data scenario (R36/R37)", () => {
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
      payload: { sourceEventId, extractorVersion: "message-v1", entities: [], structuralAtoms: [], socialBonds: [], attributes: [], ...payload },
      userId: PRIMARY_USER_ID
    });
  }

  it("correct birthdate asserted early, a bare unrelated year misextracted as a second birthdate later — getPrimaryUserBirthdate resolves to the correct one and the zodiac sidebar unlocks", () => {
    const msg1 = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "4/24/1970", attachmentOnly: false }, userId: PRIMARY_USER_ID });
    appendExtraction(msg1.id, { attributes: [{ entityName: "me", attribute: "birthdate", value: "1970-04-24", eventDate: null }] });

    // The real live failure: "1983" answered "what year did you turn 13?", not a birthdate question,
    // but the extractor tagged it as one anyway (see the R36/R37 report for the extraction-side prompt anchor).
    const msg2 = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "1983", attachmentOnly: false }, userId: PRIMARY_USER_ID });
    appendExtraction(msg2.id, { attributes: [{ entityName: "me", attribute: "birthdate", value: "1983", eventDate: null }] });

    rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);

    expect(getPrimaryUserBirthdate(projections, PRIMARY_USER_ID)).toBe("1970-04-24");

    // What the zodiac-sidebar route actually calls (app/api/zodiac-sidebar/route.ts) — before this
    // fix, this returned null/null because getPrimaryUserBirthdate returned the unparseable "1983".
    const birthdate = getPrimaryUserBirthdate(projections, PRIMARY_USER_ID)!;
    expect(getChineseZodiacSign(birthdate)).not.toBeNull();
    expect(getWesternZodiacSign(birthdate)).not.toBeNull();
  });

  it("the resolver exposes the conflict for Part B rather than hiding it", () => {
    const msg1 = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "4/24/1970", attachmentOnly: false }, userId: PRIMARY_USER_ID });
    appendExtraction(msg1.id, { attributes: [{ entityName: "me", attribute: "birthdate", value: "1970-04-24", eventDate: null }] });
    const msg2 = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "1983", attachmentOnly: false }, userId: PRIMARY_USER_ID });
    appendExtraction(msg2.id, { attributes: [{ entityName: "me", attribute: "birthdate", value: "1983", eventDate: null }] });

    rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);

    const resolved: ResolvedAttribute = resolveEntityAttribute(projections, PRIMARY_USER_ID, primaryEntityId(PRIMARY_USER_ID), "birthdate")!;
    expect(resolved.value).toBe("1970-04-24");
    expect(resolved.conflicting.map((r) => r.value)).toEqual(["1983"]);
  });

  it("location stays mutable through rebuild — a later location legitimately overrides an earlier one, unaffected by this fix", () => {
    const msg1 = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "I live in Austin.", attachmentOnly: false }, userId: PRIMARY_USER_ID });
    appendExtraction(msg1.id, { attributes: [{ entityName: "me", attribute: "location", value: "Austin", eventDate: null }] });
    const msg2 = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "I moved to Seattle.", attachmentOnly: false }, userId: PRIMARY_USER_ID });
    appendExtraction(msg2.id, { attributes: [{ entityName: "me", attribute: "location", value: "Seattle", eventDate: null }] });

    rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);

    expect(getPrimaryUserAttribute(projections, PRIMARY_USER_ID, "location")).toBe("Seattle");
  });
});

describe("assertAttribute — write-time tier (item 5b), deliberately different from read-time", () => {
  let db: ProjectionsDb;
  const entityId = primaryEntityId(PRIMARY_USER_ID);

  beforeEach(() => {
    db = new ProjectionsDb(freshTestDbPath(import.meta.url, "write-time"));
  });

  it("rejects a bare name as a birthdate at write time — the real, live, confirmed failure — and never writes the row", () => {
    const result = assertAttribute(db, PRIMARY_USER_ID, entityId, "birthdate", "Richard", ["ev1"]);
    expect(result).toBeNull();
    expect(db.listEntityAttributeHistory(PRIMARY_USER_ID, entityId, "birthdate")).toEqual([]);
  });

  it("still writes a bare, implausible-but-date-adjacent year as a birthdate — R36/R37's conflict-surfacing design, unaffected", () => {
    const result = assertAttribute(db, PRIMARY_USER_ID, entityId, "birthdate", "1983", ["ev1"]);
    expect(result).not.toBeNull();
    expect(db.listEntityAttributeHistory(PRIMARY_USER_ID, entityId, "birthdate")).toHaveLength(1);
  });

  it("still writes a partial date containing only a real month name", () => {
    const result = assertAttribute(db, PRIMARY_USER_ID, entityId, "birthdate", "April 1970", ["ev1"]);
    expect(result).not.toBeNull();
  });

  it("rejects a date-shaped value as an occupation at write time — no looser tier for a mutable attribute, nothing worth preserving", () => {
    const result = assertAttribute(db, PRIMARY_USER_ID, entityId, "occupation", "4/24/1970", ["ev1"]);
    expect(result).toBeNull();
    expect(db.listEntityAttributeHistory(PRIMARY_USER_ID, entityId, "occupation")).toEqual([]);
  });

  it("rejects a date-shaped value as a location at write time, same strictness as occupation", () => {
    const result = assertAttribute(db, PRIMARY_USER_ID, entityId, "location", "1970-04-24", ["ev1"]);
    expect(result).toBeNull();
  });

  it("still writes an ordinary occupation value", () => {
    const result = assertAttribute(db, PRIMARY_USER_ID, entityId, "occupation", "Software engineer", ["ev1"]);
    expect(result).not.toBeNull();
    expect(db.listEntityAttributeHistory(PRIMARY_USER_ID, entityId, "occupation")).toHaveLength(1);
  });

  it("still writes a fully valid birthdate", () => {
    const result = assertAttribute(db, PRIMARY_USER_ID, entityId, "birthdate", "4/24/1970", ["ev1"]);
    expect(result).not.toBeNull();
    expect(result!.value).toBe("4/24/1970");
  });
});

describe("fact_corrected attribute-value correction, via full rebuild (item 4 #2)", () => {
  let eventLog: EventLog;
  let projections: ProjectionsDb;

  beforeEach(() => {
    eventLog = new EventLog(freshTestDbPath(import.meta.url, "events"));
    projections = new ProjectionsDb(freshTestDbPath(import.meta.url, "projections"));
  });

  // Deliberately NOT "Richard" here: item 5's write-time validation
  // already rejects that at the source on every rebuild (rebuild
  // reprocesses the whole event log from scratch every call — there is
  // no longer a scenario where a bare-name birthdate ever reaches
  // storage to correct in the first place). fact_corrected/#2 exists for
  // a case write-time validation structurally CANNOT catch: a FULLY
  // valid-format date that's simply the wrong one. For an immutable
  // attribute, "oldest valid wins" — so even an ordinary LATER, correct
  // assertion can never override the first (wrong) one; only a
  // deliberate, explicit correction can.
  it("overrides 'oldest valid wins' for an immutable attribute — an ordinary later assertion can't, only an explicit correction can", () => {
    const msg = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "1975-01-01", attachmentOnly: false }, userId: PRIMARY_USER_ID });
    const extraction = eventLog.append({
      type: "extraction_completed",
      actor: "system",
      payload: { sourceEventId: msg.id, extractorVersion: "message-v1", entities: [], structuralAtoms: [], socialBonds: [], attributes: [{ entityName: "me", attribute: "birthdate", value: "1975-01-01", eventDate: null }] },
      userId: PRIMARY_USER_ID
    });

    // Before the correction: the wrong-but-fully-valid date is the ONLY row, so it wins outright.
    const before = rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);
    expect(getPrimaryUserBirthdate(projections, PRIMARY_USER_ID)).toBe("1975-01-01");
    expect(before.attributeCorrectionsApplied).toBe(0);

    eventLog.append({
      type: "fact_corrected",
      actor: "user",
      payload: { targetEventId: extraction.id, entityName: "me", attribute: "birthdate", correctedValue: "1970-04-24" },
      userId: PRIMARY_USER_ID
    });

    const after = rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);
    expect(after.attributeCorrectionsApplied).toBe(1);
    expect(getPrimaryUserBirthdate(projections, PRIMARY_USER_ID)).toBe("1970-04-24");

    // The wrong row is genuinely GONE, not merely outranked — only one row remains, and it's the corrected value.
    const history = projections.listEntityAttributeHistory(PRIMARY_USER_ID, primaryEntityId(PRIMARY_USER_ID), "birthdate");
    expect(history.map((r) => r.value)).toEqual(["1970-04-24"]);
  });

  it("a correction that resolves to an implausible value is rejected at write time (item 5), and the old row survives untouched", () => {
    const msg = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "1975-01-01", attachmentOnly: false }, userId: PRIMARY_USER_ID });
    const extraction = eventLog.append({
      type: "extraction_completed",
      actor: "system",
      payload: { sourceEventId: msg.id, extractorVersion: "message-v1", entities: [], structuralAtoms: [], socialBonds: [], attributes: [{ entityName: "me", attribute: "birthdate", value: "1975-01-01", eventDate: null }] },
      userId: PRIMARY_USER_ID
    });
    eventLog.append({
      type: "fact_corrected",
      actor: "user",
      payload: { targetEventId: extraction.id, entityName: "me", attribute: "birthdate", correctedValue: "Bob" },
      userId: PRIMARY_USER_ID
    });

    const result = rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);

    expect(result.attributeCorrectionsApplied).toBe(0);
    // The rejected correction must never destroy the old row — it's still the best available value.
    expect(getPrimaryUserBirthdate(projections, PRIMARY_USER_ID)).toBe("1975-01-01");
    const history = projections.listEntityAttributeHistory(PRIMARY_USER_ID, primaryEntityId(PRIMARY_USER_ID), "birthdate");
    expect(history.map((r) => r.value)).toEqual(["1975-01-01"]);
  });

  it("a correction targeting an event that produced no such attribute is a no-op, never a search or a guess", () => {
    const msg = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "hello", attachmentOnly: false }, userId: PRIMARY_USER_ID });
    eventLog.append({
      type: "fact_corrected",
      actor: "user",
      payload: { targetEventId: msg.id, entityName: "me", attribute: "birthdate", correctedValue: "1970-04-24" },
      userId: PRIMARY_USER_ID
    });

    const result = rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);

    expect(result.attributeCorrectionsApplied).toBe(0);
    expect(getPrimaryUserBirthdate(projections, PRIMARY_USER_ID)).toBeNull();
  });
});
