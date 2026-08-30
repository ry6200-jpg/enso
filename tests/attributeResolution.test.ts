import { beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/events/eventLog.js";
import { ProjectionsDb } from "../src/projections/db.js";
import { primaryEntityId, rebuildProjections } from "../src/projections/rebuild.js";
import { assertAttribute, getCurrentAttribute, isValidAttributeValue, resolveAttribute, resolveEntityAttribute, type ResolvedAttribute } from "../src/perception/attributes.js";
import { getPrimaryUserBirthdate, getPrimaryUserAttribute } from "../src/projections/peopleView.js";
import { getChineseZodiacSign, getWesternZodiacSign } from "../src/zodiac/zodiac.js";
import type { EntityAttributeRow } from "../src/projections/db.js";
import { freshTestDbPath } from "../src/test/dbPath.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";

function row(id: string, attribute: EntityAttributeRow["attribute"], value: string): EntityAttributeRow {
  return { id, user_id: PRIMARY_USER_ID, entity_id: primaryEntityId(PRIMARY_USER_ID), attribute, value, source_event_ids: "[]", created_at: "2026-01-01T00:00:00.000Z" };
}

function inferredRow(id: string, attribute: EntityAttributeRow["attribute"], value: string): EntityAttributeRow {
  return { ...row(id, attribute, value), provenance_kind: "inferred" };
}

/** Phase 2 temporal markers: a row explicitly closed as of intervalEnd (told-time, per closeEntityAttribute's own precedent). */
function closedRow(id: string, attribute: EntityAttributeRow["attribute"], value: string, intervalEnd: string): EntityAttributeRow {
  return { ...row(id, attribute, value), interval_end: intervalEnd };
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

  it("mutable (life_stage, EN-114): latest wins, never flagged as a conflict — same model as occupation, deliberately NOT birthdate's immutable model. Free text, no vocabulary — unlike gender (see the next test), it has no format validation. (sexual_orientation was the other free-text member of this trio; removed from the vocabulary entirely — deprecation batch, post-EN-129.)", () => {
    const history = [row("a", "life_stage", "first stated value"), row("b", "life_stage", "a later clarification")];
    const resolved = resolveAttribute(history)!;
    expect(resolved.value).toBe("a later clarification");
    expect(resolved.conflicting).toEqual([]);
  });

  it("mutable (gender, role-word disambiguation batch): latest wins, never flagged as a conflict — same mutability model as occupation, but values must be in-vocabulary (male/female)", () => {
    const history = [row("a", "gender", "male"), row("b", "gender", "female")];
    const resolved = resolveAttribute(history)!;
    expect(resolved.value).toBe("female");
    expect(resolved.conflicting).toEqual([]);
  });

  it("EN-115 (mutable): a stated value silently supersedes an inferred one, even when the inferred row is LATER — never flagged as a conflict", () => {
    const history = [row("a", "location", "Seattle"), inferredRow("b", "location", "Portland")];
    const resolved = resolveAttribute(history)!;
    expect(resolved.value).toBe("Seattle");
    expect(resolved.row.id).toBe("a");
    expect(resolved.conflicting).toEqual([]);
  });

  it("EN-115 (immutable): a stated value silently supersedes a disagreeing inferred one — not surfaced as a conflict the way two stated values would be", () => {
    const history = [row("a", "birthdate", "1970-04-24"), inferredRow("b", "birthdate", "1983")];
    const resolved = resolveAttribute(history)!;
    expect(resolved.value).toBe("1970-04-24");
    expect(resolved.conflicting).toEqual([]);
  });

  it("EN-115: an inferred value resolves only when NO stated row exists at all for that (entity, attribute)", () => {
    const history = [inferredRow("a", "location", "Portland")];
    const resolved = resolveAttribute(history)!;
    expect(resolved.value).toBe("Portland");
  });

  it("EN-115: multiple stated values still conflict/resolve normally amongst themselves, ignoring any inferred rows present", () => {
    const history = [row("a", "birthdate", "1970-04-24"), row("b", "birthdate", "1983"), inferredRow("c", "birthdate", "1999")];
    const resolved = resolveAttribute(history)!;
    expect(resolved.value).toBe("1970-04-24");
    expect(resolved.conflicting.map((r) => r.value)).toEqual(["1983"]);
  });
});

describe("resolveAttribute — eventDate-aware mutable resolution (owner-reported hardening: cap future-dated aspirations, and order multiple dated facts by their real date instead of text order)", () => {
  const NOW = "2026-08-29T00:00:00.000Z";

  it("PARTIALLY SUPERSEDED BY PHASE 2 (see the open/closed describe block below): when NEITHER row uses the new interval_end marker, an undated current value CAN still be overridden by a later mention with only an explicit past eventDate — undecidable from eventDate alone, with no started/ended marker in play. This gap is now genuinely closeable (interval_end), but only when a caller actually uses it; eventDate alone still resolves exactly as before.", () => {
    const history = [row("a", "location", "LA"), row("b", "location", "Toledo")]; // "b" (Toledo) is textually last, exactly the shape that used to win under plain last-inserted-wins
    const eventDates = new Map([["b", "1995-06-01"]]); // "a" (LA) stays undated — an ordinary present-tense "I live in LA"
    const resolved = resolveAttribute(history, eventDates, NOW)!;
    expect(resolved.value).toBe("Toledo"); // unaffected by eventDate alone — see closedRow-based tests below for the real fix
  });

  it("an undated ORIGINAL value correctly loses to a LATER mention with a genuinely recent, non-future eventDate — the ordinary update case, unaffected by the future-date cap", () => {
    const history = [row("a", "location", "Austin"), row("b", "location", "Seattle")];
    const eventDates = new Map([["b", "2025-08-01"]]); // "I moved to Seattle last year" — a real, recent, non-future date
    const resolved = resolveAttribute(history, eventDates, NOW)!;
    expect(resolved.value).toBe("Seattle");
  });

  it("a future-dated aspiration never becomes current, even though its own date is numerically the latest", () => {
    const history = [row("a", "location", "LA"), row("b", "location", "Florida")];
    const eventDates = new Map([["b", "2030-01-01"]]); // a stated future retirement plan
    const resolved = resolveAttribute(history, eventDates, NOW)!;
    expect(resolved.value).toBe("LA");
  });

  it("two explicitly dated facts resolve by their real date, not by which was typed later", () => {
    const history = [row("a", "location", "Chicago"), row("b", "location", "Seattle")]; // "b" (Seattle) is textually last
    const eventDates = new Map([
      ["a", "2020-06-01"], // Chicago: dated LATER in real terms, even though typed first
      ["b", "2018-01-01"] // Seattle: dated EARLIER, even though typed last
    ]);
    const resolved = resolveAttribute(history, eventDates, NOW)!;
    expect(resolved.value).toBe("Chicago");
    expect(resolved.row.id).toBe("a");
  });

  it("with no eventDate data at all (the default), resolution is byte-for-byte identical to plain last-inserted-wins", () => {
    const history = [row("a", "location", "Austin"), row("b", "location", "Seattle")];
    expect(resolveAttribute(history, new Map(), NOW)!.value).toBe("Seattle");
    expect(resolveAttribute(history)!.value).toBe("Seattle"); // omitting the params entirely behaves the same
  });

  it("a same-day eventDate on the textually-last row still wins over an earlier undated row — the cap excludes only STRICTLY future dates", () => {
    const history = [row("a", "location", "Austin"), row("b", "location", "Seattle")];
    const eventDates = new Map([["b", NOW.slice(0, 10)]]); // dated exactly today, not future
    expect(resolveAttribute(history, eventDates, NOW)!.value).toBe("Seattle");
  });

  it("immutable (birthdate) resolution is completely unaffected by eventDateByRowId — oldest-valid-wins regardless of dates", () => {
    const history = [row("a", "birthdate", "1970-04-24"), row("b", "birthdate", "1983")];
    const eventDates = new Map([
      ["a", "1970-04-24"],
      ["b", "2020-01-01"] // even a much "later" date on the second row must not matter for an immutable attribute
    ]);
    const resolved = resolveAttribute(history, eventDates, NOW)!;
    expect(resolved.value).toBe("1970-04-24");
    expect(resolved.conflicting.map((r) => r.value)).toEqual(["1983"]);
  });
});

describe("resolveAttribute — Phase 2 temporal markers (interval_end): an open row can never lose to a closed one, unconditionally", () => {
  const NOW = "2026-08-29T00:00:00.000Z";

  it("THE FIX: an undated, OPEN current value now correctly beats a later mention with an explicit past eventDate, once that mention is actually marked closed — no eventDate comparison needed at all", () => {
    const history = [row("a", "location", "LA"), closedRow("b", "location", "Toledo", "2026-01-01T00:00:00.000Z")]; // "b" (Toledo) is textually last AND has a "later" eventDate below — both signals that used to win, neither wins now
    const eventDates = new Map([["b", "1995-06-01"]]);
    const resolved = resolveAttribute(history, eventDates, NOW)!;
    expect(resolved.value).toBe("LA");
    expect(resolved.row.id).toBe("a");
  });

  it("open beats closed regardless of insertion order — a closed row asserted FIRST still can't beat an open row asserted later", () => {
    const history = [closedRow("a", "location", "Toledo", "2026-01-01T00:00:00.000Z"), row("b", "location", "LA")];
    expect(resolveAttribute(history)!.value).toBe("LA");
  });

  it("open beats closed even when the closed row's own eventDate is MORE recent than the open row's", () => {
    const history = [row("a", "location", "LA"), closedRow("b", "location", "Toledo", "2026-01-01T00:00:00.000Z")];
    const eventDates = new Map([["b", "2025-01-01"]]); // Toledo's stated date is more recent than LA's (undated) — still loses, because it's closed
    expect(resolveAttribute(history, eventDates, NOW)!.value).toBe("LA");
  });

  it("when EVERY row for the attribute is closed, resolution falls back to the closed rows themselves — a stale-but-real answer beats none at all", () => {
    const history = [closedRow("a", "location", "Toledo", "2020-01-01T00:00:00.000Z"), closedRow("b", "location", "Chicago", "2023-01-01T00:00:00.000Z")];
    const resolved = resolveAttribute(history)!;
    expect(resolved.value).toBe("Chicago"); // the existing tie-break (last-wins, unaffected) still decides WHICH closed row, once there's no open candidate
  });

  it("among multiple OPEN rows, a closed row never even enters the comparison — the existing eventDate/insertion-order tie-break is unchanged for the open pool", () => {
    const history = [row("a", "location", "Austin"), closedRow("b", "location", "Toledo", "2026-01-01T00:00:00.000Z"), row("c", "location", "Seattle")];
    expect(resolveAttribute(history)!.value).toBe("Seattle"); // last OPEN row wins, exactly as it would with "b" removed entirely
  });

  it("immutable (birthdate) resolution ignores interval_end entirely — oldest-valid-wins regardless of any closed marker", () => {
    const history = [row("a", "birthdate", "1970-04-24"), closedRow("b", "birthdate", "1983", "2026-01-01T00:00:00.000Z")];
    const resolved = resolveAttribute(history)!;
    expect(resolved.value).toBe("1970-04-24");
    expect(resolved.conflicting.map((r) => r.value)).toEqual(["1983"]); // still surfaced as a conflict, not silently excluded for being "closed" — closing has no meaning for an immutable attribute
  });
});

describe("resolveEntityAttribute — eventDate-aware resolution end-to-end through rebuild (perception_logs.event_at)", () => {
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

  const NOW = "2026-08-29T00:00:00.000Z"; // fixed, not wall-clock — keeps the future-date test from breaking once real time passes 2030

  it("without action: 'close' (e.g. old cached extraction, message-v3 and earlier), a childhood location mentioned AFTER the current one still overwrites it through full rebuild — see the Phase 2 describe block below for the real fix using action: 'close'", () => {
    const msg1 = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "I live in LA.", attachmentOnly: false }, userId: PRIMARY_USER_ID });
    appendExtraction(msg1.id, { attributes: [{ entityName: "me", attribute: "location", value: "LA", eventDate: null }] });
    const msg2 = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "I grew up in Toledo back in the 90s, moved away in 1995.", attachmentOnly: false }, userId: PRIMARY_USER_ID });
    appendExtraction(msg2.id, { attributes: [{ entityName: "me", attribute: "location", value: "Toledo", eventDate: "1995-01-01" }] }); // no action field — defaults to "open"

    rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);

    expect(resolveEntityAttribute(projections, PRIMARY_USER_ID, primaryEntityId(PRIMARY_USER_ID), "location", NOW)!.value).toBe("Toledo");
  });

  it("a stated future relocation plan never becomes the current location", () => {
    const msg1 = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "I live in LA.", attachmentOnly: false }, userId: PRIMARY_USER_ID });
    appendExtraction(msg1.id, { attributes: [{ entityName: "me", attribute: "location", value: "LA", eventDate: null }] });
    const msg2 = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "Once I retire I want to move to Florida.", attachmentOnly: false }, userId: PRIMARY_USER_ID });
    appendExtraction(msg2.id, { attributes: [{ entityName: "me", attribute: "location", value: "Florida", eventDate: "2030-01-01" }] });

    rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);

    expect(resolveEntityAttribute(projections, PRIMARY_USER_ID, primaryEntityId(PRIMARY_USER_ID), "location", NOW)!.value).toBe("LA");
  });

  it("a genuinely more recent, explicitly dated move still correctly becomes current, even without a same-turn undated statement", () => {
    const msg1 = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "I live in Austin.", attachmentOnly: false }, userId: PRIMARY_USER_ID });
    appendExtraction(msg1.id, { attributes: [{ entityName: "me", attribute: "location", value: "Austin", eventDate: null }] });
    const msg2 = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "I moved to Seattle last year.", attachmentOnly: false }, userId: PRIMARY_USER_ID });
    appendExtraction(msg2.id, { attributes: [{ entityName: "me", attribute: "location", value: "Seattle", eventDate: "2025-08-01" }] });

    rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);

    expect(resolveEntityAttribute(projections, PRIMARY_USER_ID, primaryEntityId(PRIMARY_USER_ID), "location", NOW)!.value).toBe("Seattle");
  });
});

describe("rebuild.ts — Phase 2 action: 'close', end-to-end (the real fix for the undated-vs-dated gap)", () => {
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
      payload: { sourceEventId, extractorVersion: "message-v4", entities: [], structuralAtoms: [], socialBonds: [], attributes: [], ...payload },
      userId: PRIMARY_USER_ID
    });
  }

  const NOW = "2026-08-29T00:00:00.000Z";

  it("THE FIX, end-to-end: a historical aside never previously on record, tagged action: 'close', is recorded but can never overwrite the current open location", () => {
    const msg1 = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "I live in LA.", attachmentOnly: false }, userId: PRIMARY_USER_ID });
    appendExtraction(msg1.id, { attributes: [{ entityName: "me", attribute: "location", value: "LA", eventDate: null, action: "open" }] });
    const msg2 = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "I grew up in Toledo, moved away in 1995.", attachmentOnly: false }, userId: PRIMARY_USER_ID });
    appendExtraction(msg2.id, { attributes: [{ entityName: "me", attribute: "location", value: "Toledo", eventDate: "1995-01-01", action: "close" }] });

    rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);

    expect(resolveEntityAttribute(projections, PRIMARY_USER_ID, primaryEntityId(PRIMARY_USER_ID), "location", NOW)!.value).toBe("LA");
    // The historical fact is still genuinely RECORDED, never silently discarded — just excluded from currency.
    const history = projections.listEntityAttributeHistory(PRIMARY_USER_ID, primaryEntityId(PRIMARY_USER_ID), "location");
    const toledo = history.find((r) => r.value === "Toledo")!;
    expect(toledo.interval_end).not.toBeNull();
    expect(toledo.interval_start).toBe("1995-01-01");
  });

  it("closing a value that IS currently on record as open closes that EXISTING row (told-time, not a parsed date) rather than inserting a duplicate", () => {
    const msg1 = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "I live in Toledo.", attachmentOnly: false }, userId: PRIMARY_USER_ID });
    appendExtraction(msg1.id, { attributes: [{ entityName: "me", attribute: "location", value: "Toledo", eventDate: null, action: "open" }] });
    const msg2 = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "I finally moved out of Toledo last month.", attachmentOnly: false }, userId: PRIMARY_USER_ID });
    appendExtraction(msg2.id, { attributes: [{ entityName: "me", attribute: "location", value: "Toledo", eventDate: null, action: "close" }] });

    rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);

    const history = projections.listEntityAttributeHistory(PRIMARY_USER_ID, primaryEntityId(PRIMARY_USER_ID), "location");
    expect(history).toHaveLength(1); // closed the EXISTING row — no duplicate second row for the same value
    expect(history[0]!.value).toBe("Toledo");
    expect(history[0]!.interval_end).not.toBeNull();
    // resolution now has nothing open at all — falls back to the best closed row, never silently returning nothing.
    expect(resolveEntityAttribute(projections, PRIMARY_USER_ID, primaryEntityId(PRIMARY_USER_ID), "location", NOW)!.value).toBe("Toledo");
  });

  it("a NEW open location after a closed one resolves correctly — closing the old value doesn't block a genuine subsequent update", () => {
    const msg1 = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "I live in Toledo.", attachmentOnly: false }, userId: PRIMARY_USER_ID });
    appendExtraction(msg1.id, { attributes: [{ entityName: "me", attribute: "location", value: "Toledo", eventDate: null, action: "open" }] });
    const msg2 = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "I moved out of Toledo.", attachmentOnly: false }, userId: PRIMARY_USER_ID });
    appendExtraction(msg2.id, { attributes: [{ entityName: "me", attribute: "location", value: "Toledo", eventDate: null, action: "close" }] });
    const msg3 = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "I live in Seattle now.", attachmentOnly: false }, userId: PRIMARY_USER_ID });
    appendExtraction(msg3.id, { attributes: [{ entityName: "me", attribute: "location", value: "Seattle", eventDate: null, action: "open" }] });

    rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);

    expect(resolveEntityAttribute(projections, PRIMARY_USER_ID, primaryEntityId(PRIMARY_USER_ID), "location", NOW)!.value).toBe("Seattle");
  });

  it("a rebuild wipes and correctly re-derives closed rows, never accumulating duplicate closures across repeated rebuilds", () => {
    const msg1 = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "I live in Toledo.", attachmentOnly: false }, userId: PRIMARY_USER_ID });
    appendExtraction(msg1.id, { attributes: [{ entityName: "me", attribute: "location", value: "Toledo", eventDate: null, action: "open" }] });
    const msg2 = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "I moved out of Toledo.", attachmentOnly: false }, userId: PRIMARY_USER_ID });
    appendExtraction(msg2.id, { attributes: [{ entityName: "me", attribute: "location", value: "Toledo", eventDate: null, action: "close" }] });

    rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);
    rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);
    rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);

    const history = projections.listEntityAttributeHistory(PRIMARY_USER_ID, primaryEntityId(PRIMARY_USER_ID), "location");
    expect(history).toHaveLength(1);
    expect(history[0]!.interval_end).not.toBeNull();
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

  it("EN-115/116: defaults provenance_kind to 'stated' and matching_eligible to 0 — no caller can currently set either otherwise", () => {
    const result = assertAttribute(db, PRIMARY_USER_ID, entityId, "occupation", "Software engineer", ["ev1"]);
    expect(result!.provenance_kind).toBe("stated");
    expect(result!.matching_eligible).toBe(0);
  });

  it("EN-115: assertAttribute writes 'inferred' when the caller passes it explicitly", () => {
    const result = assertAttribute(db, PRIMARY_USER_ID, entityId, "location", "Seattle", ["ev1"], "inferred");
    expect(result!.provenance_kind).toBe("inferred");
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

describe("isValidAttributeValue — gender vocabulary (role-word disambiguation batch)", () => {
  it("accepts male and female", () => {
    expect(isValidAttributeValue("gender", "male")).toBe(true);
    expect(isValidAttributeValue("gender", "female")).toBe(true);
  });

  it("rejects a bare pronoun — the real production data bug this closes ('she' landed in the gender field with nothing to catch it)", () => {
    expect(isValidAttributeValue("gender", "she")).toBe(false);
    expect(isValidAttributeValue("gender", "he")).toBe(false);
  });

  it("rejects anything else outside the vocabulary — case-sensitive, no synonyms, no free text", () => {
    expect(isValidAttributeValue("gender", "Male")).toBe(false);
    expect(isValidAttributeValue("gender", "nonbinary")).toBe(false);
    expect(isValidAttributeValue("gender", "")).toBe(false);
  });

  it("other attributes are unaffected by the gender vocabulary check", () => {
    expect(isValidAttributeValue("occupation", "she")).toBe(true);
    expect(isValidAttributeValue("life_stage", "empty nester")).toBe(true);
  });
});
