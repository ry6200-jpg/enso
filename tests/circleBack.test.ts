import { beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/events/eventLog.js";
import { ProjectionsDb } from "../src/projections/db.js";
import { primaryEntityId } from "../src/projections/rebuild.js";
import { buildCircleBackDirective, findEligibleCircleBackCandidates, MAX_CIRCLE_BACK_ATTEMPTS, verifyCircleBackExecuted } from "../src/conversation/circleBack.js";
import type { ReplySentPayload } from "../src/conversation/chatPipeline.js";
import { newId } from "../src/ids.js";
import { freshTestDbPath } from "../src/test/dbPath.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";

let eventLog: EventLog;
let projections: ProjectionsDb;

beforeEach(() => {
  eventLog = new EventLog(freshTestDbPath(import.meta.url, "events"));
  projections = new ProjectionsDb(freshTestDbPath(import.meta.url, "projections"));
});

function userTurn(text: string) {
  return eventLog.append({ type: "message_sent", actor: "user", payload: { text, attachmentOnly: false }, userId: PRIMARY_USER_ID });
}

function insertEntity(name: string, sourceEventIds: string[]) {
  const id = newId();
  projections.insertEntity({
    id,
    user_id: PRIMARY_USER_ID,
    name,
    confirmed: 0,
    source_event_ids: JSON.stringify(sourceEventIds),
    extractor_version: "message-v1",
    pending_disambiguation: null,
    created_at: new Date().toISOString()
  });
  return id;
}

function establishAsFamily(entityId: string) {
  projections.insertStructuralAtom({
    id: newId(),
    user_id: PRIMARY_USER_ID,
    type: "parent_of",
    from_entity_id: entityId,
    to_entity_id: primaryEntityId(PRIMARY_USER_ID),
    basis: "stated",
    interval_start: null,
    interval_end: null,
    source_event_ids: JSON.stringify([]),
    created_at: new Date().toISOString()
  });
}

function recordCircleBackFired(inReplyToEventId: string, entityId: string, name: string) {
  const payload: Partial<ReplySentPayload> = { gateActions: { circleBackFired: { entityId, name }, attestationConfirmedEventId: null }, inReplyToEventId } as ReplySentPayload;
  return eventLog.append({ type: "reply_sent", actor: "enso", payload, userId: PRIMARY_USER_ID });
}

describe("findEligibleCircleBackCandidates (EN-030/070-073)", () => {
  it("an unestablished entity (no structural atom, no social bond to the primary user) is eligible", () => {
    const msg = userTurn("My coworker Marcus helped me move a couch.");
    insertEntity("Marcus", [msg.id]);

    const candidates = findEligibleCircleBackCandidates(eventLog, projections, PRIMARY_USER_ID, "just a regular update");

    expect(candidates.map((c) => c.name)).toContain("Marcus");
  });

  it("an entity already established via a structural atom is NOT eligible", () => {
    const msg = userTurn("My mother Elena lives in Seattle.");
    const elenaId = insertEntity("Elena", [msg.id]);
    establishAsFamily(elenaId);

    const candidates = findEligibleCircleBackCandidates(eventLog, projections, PRIMARY_USER_ID, "just a regular update");

    expect(candidates.map((c) => c.name)).not.toContain("Elena");
  });

  it("the current message being a direct question suppresses circle-back entirely this turn", () => {
    const msg = userTurn("My coworker Marcus helped me move a couch.");
    insertEntity("Marcus", [msg.id]);

    const candidates = findEligibleCircleBackCandidates(eventLog, projections, PRIMARY_USER_ID, "What time is it?");

    expect(candidates).toEqual([]);
  });

  it("an entity already attempted MAX_CIRCLE_BACK_ATTEMPTS times is no longer eligible", () => {
    const msg = userTurn("My coworker Marcus helped me move a couch.");
    const marcusId = insertEntity("Marcus", [msg.id]);
    for (let i = 0; i < MAX_CIRCLE_BACK_ATTEMPTS; i++) {
      const turn = userTurn(`filler turn ${i}`);
      recordCircleBackFired(turn.id, marcusId, "Marcus");
      // Advance past cooldown between attempts so the loop itself doesn't
      // trip the cooldown check before reaching the attempt cap.
      for (let j = 0; j < 6; j++) userTurn(`cooldown filler ${i}-${j}`);
    }

    const candidates = findEligibleCircleBackCandidates(eventLog, projections, PRIMARY_USER_ID, "just a regular update");

    expect(candidates.map((c) => c.name)).not.toContain("Marcus");
  });

  it("a cooldown is active immediately after a firing — no candidates at all until it lapses", () => {
    const msg = userTurn("My coworker Marcus helped me move a couch.");
    const marcusId = insertEntity("Marcus", [msg.id]);
    const fireTurn = userTurn("some later turn");
    recordCircleBackFired(fireTurn.id, marcusId, "Marcus");

    const candidates = findEligibleCircleBackCandidates(eventLog, projections, PRIMARY_USER_ID, "just a regular update");

    expect(candidates).toEqual([]);
  });

  it("an entity first mentioned long ago (outside the recency window) ages out rather than surfacing out of nowhere", () => {
    const msg = userTurn("My coworker Marcus helped me move a couch.");
    insertEntity("Marcus", [msg.id]);
    // Push the recency window well past Marcus's introduction.
    for (let i = 0; i < 10; i++) userTurn(`unrelated turn ${i}`);

    const candidates = findEligibleCircleBackCandidates(eventLog, projections, PRIMARY_USER_ID, "just a regular update");

    expect(candidates.map((c) => c.name)).not.toContain("Marcus");
  });
});

describe("Option B (Phase 7 Part 0): retries waive recency, hard cap holds, fresh outranks retry", () => {
  it("the old deadlock case: a second attempt is now reachable after cooldown, even though the entity's introduction has aged out of the recency window", () => {
    const msg = userTurn("Marcus helped me carry some boxes.");
    const marcusId = insertEntity("Marcus", [msg.id]);
    const firstFireTurn = userTurn("turn 2 — first attempt fires here");
    recordCircleBackFired(firstFireTurn.id, marcusId, "Marcus");

    // Advance exactly enough turns to clear the 5-turn cooldown AND push
    // well past the 5-turn recency window relative to Marcus's introduction
    // — under the pre-Option-B design this combination was structurally
    // unreachable (verified live during Phase 6: 0 firings ever reached a
    // second attempt with these exact window/cooldown values).
    for (let i = 0; i < 6; i++) userTurn(`filler turn ${i}`);

    const candidates = findEligibleCircleBackCandidates(eventLog, projections, PRIMARY_USER_ID, "just a regular update");

    expect(candidates).toEqual([{ entityId: marcusId, name: "Marcus", attemptNumber: 2, mentionAgeLabel: expect.any(String) }]);
  });

  it("hard cap: a third attempt is never offered, even after another full cooldown period", () => {
    const msg = userTurn("Marcus helped me carry some boxes.");
    const marcusId = insertEntity("Marcus", [msg.id]);
    const firstFireTurn = userTurn("first attempt fires here");
    recordCircleBackFired(firstFireTurn.id, marcusId, "Marcus");
    for (let i = 0; i < 6; i++) userTurn(`filler ${i}`);
    const secondFireTurn = userTurn("second attempt fires here");
    recordCircleBackFired(secondFireTurn.id, marcusId, "Marcus");
    for (let i = 0; i < 6; i++) userTurn(`more filler ${i}`);

    const candidates = findEligibleCircleBackCandidates(eventLog, projections, PRIMARY_USER_ID, "just a regular update");

    expect(candidates.map((c) => c.name)).not.toContain("Marcus");
  });

  it("priority: a fresh, recency-eligible candidate is offered alone, even when a cooldown-cleared retry candidate also exists", () => {
    const marcusMsg = userTurn("Marcus helped me carry some boxes.");
    const marcusId = insertEntity("Marcus", [marcusMsg.id]);
    const firstFireTurn = userTurn("first attempt on Marcus fires here");
    recordCircleBackFired(firstFireTurn.id, marcusId, "Marcus");
    for (let i = 0; i < 5; i++) userTurn(`filler ${i}`); // clears cooldown, Marcus now retry-eligible

    // A brand new person, freshly mentioned, also becomes a candidate this turn.
    const priyaMsg = userTurn("Ran into Priya at the store today.");
    const priyaId = insertEntity("Priya", [priyaMsg.id]);

    const candidates = findEligibleCircleBackCandidates(eventLog, projections, PRIMARY_USER_ID, "just a regular update");

    expect(candidates).toEqual([{ entityId: priyaId, name: "Priya", attemptNumber: 1, mentionAgeLabel: expect.any(String) }]);
  });
});

describe("verifyCircleBackExecuted (EN-073 — directive-execution verification)", () => {
  it("returns true when the reply actually mentions the candidate's name", () => {
    expect(verifyCircleBackExecuted("By the way, who is Marcus to you?", "Marcus")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(verifyCircleBackExecuted("who is marcus, exactly?", "Marcus")).toBe(true);
  });

  it("returns false when the reply never mentions the candidate — R7's exact failure mode", () => {
    expect(verifyCircleBackExecuted("That sounds like a busy day.", "Marcus")).toBe(false);
  });
});

describe("buildCircleBackDirective", () => {
  it("names the specific candidate", () => {
    expect(buildCircleBackDirective("Marcus")).toContain("Marcus");
  });
});
