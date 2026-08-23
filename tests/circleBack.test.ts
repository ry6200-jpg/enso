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

function recordCircleBackFired(inReplyToEventId: string, entityId: string, name: string, stableKey: string) {
  const payload: Partial<ReplySentPayload> = { gateActions: { circleBackFired: { entityId, name, stableKey }, attestationConfirmedEventId: null }, inReplyToEventId } as ReplySentPayload;
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
      recordCircleBackFired(turn.id, marcusId, "Marcus", msg.id);
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
    recordCircleBackFired(fireTurn.id, marcusId, "Marcus", msg.id);

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

describe("Name-clarification rule (adversarial-test batch, item 2): second attempt gated on genuine re-mention, never elapsed time alone", () => {
  it("stays dormant after cooldown clears with NO re-mention — the exact live-caught defect this replaces (old Option B would have re-raised it here)", () => {
    const msg = userTurn("Marcus helped me carry some boxes.");
    const marcusId = insertEntity("Marcus", [msg.id]);
    const firstFireTurn = userTurn("turn 2 — first attempt fires here");
    recordCircleBackFired(firstFireTurn.id, marcusId, "Marcus", msg.id);

    // Clears the cooldown (and would have aged out of the recency window
    // too) — under the OLD Option B design this alone reopened a second
    // attempt. Nobody re-mentioned Marcus, so it must stay dormant now.
    for (let i = 0; i < 6; i++) userTurn(`filler turn ${i}`);

    const candidates = findEligibleCircleBackCandidates(eventLog, projections, PRIMARY_USER_ID, "just a regular update");

    expect(candidates.map((c) => c.name)).not.toContain("Marcus");
  });

  it("a genuine re-mention two-plus turns after the first attempt makes a second, final attempt eligible", () => {
    const msg = userTurn("Marcus helped me carry some boxes.");
    const marcusId = insertEntity("Marcus", [msg.id]);
    const firstFireTurn = userTurn("first attempt fires here");
    recordCircleBackFired(firstFireTurn.id, marcusId, "Marcus", msg.id);
    userTurn("some unrelated reply to the ask"); // the direct reply turn — never itself counts as a re-mention
    const remention = userTurn("Marcus came up again today, actually.");
    // Simulates what extraction/touchEntity actually does on a real re-mention: the entity's own provenance grows to include the new message.
    projections.touchEntity(marcusId, [remention.id], "message-v1");
    for (let i = 0; i < 5; i++) userTurn(`filler ${i}`); // clear cooldown

    const candidates = findEligibleCircleBackCandidates(eventLog, projections, PRIMARY_USER_ID, "just a regular update");

    expect(candidates).toEqual([{ entityId: marcusId, name: "Marcus", attemptNumber: 2, mentionAgeLabel: expect.any(String), stableKey: msg.id }]);
  });

  it("the IMMEDIATE reply to the ask repeating the name does NOT itself count as a re-mention, even if it dismisses in the same breath", () => {
    const msg = userTurn("Marcus helped me carry some boxes.");
    const marcusId = insertEntity("Marcus", [msg.id]);
    const firstFireTurn = userTurn("first attempt fires here");
    recordCircleBackFired(firstFireTurn.id, marcusId, "Marcus", msg.id);
    // A dismissal that happens to repeat the name in the SAME direct reply — extraction could plausibly still tag this as a mention.
    const dismissal = userTurn("Marcus is no one, ignore that.");
    projections.touchEntity(marcusId, [dismissal.id], "message-v1");
    for (let i = 0; i < 5; i++) userTurn(`filler ${i}`); // clear cooldown

    const candidates = findEligibleCircleBackCandidates(eventLog, projections, PRIMARY_USER_ID, "just a regular update");

    expect(candidates.map((c) => c.name)).not.toContain("Marcus");
  });

  it("survives entity id churn across a rebuild — attempt tracking still keys on stable provenance, never the ephemeral projection id, even with the new re-mention requirement", () => {
    const msg = userTurn("Marcus helped me carry some boxes.");
    const marcusIdBeforeRebuild = insertEntity("Marcus", [msg.id]);
    const firstFireTurn = userTurn("first attempt fires here");
    recordCircleBackFired(firstFireTurn.id, marcusIdBeforeRebuild, "Marcus", msg.id);
    userTurn("the direct reply to the ask");
    const remention = userTurn("Marcus came up again.");
    for (let i = 0; i < 5; i++) userTurn(`filler ${i}`);

    // Simulate what rebuildProjections actually does after every turn in
    // production (scripts/chat.ts / turnMemoryRefresh.ts): drop projections
    // and recreate the entity fresh, which assigns it a BRAND NEW id, while
    // its real provenance (source_event_ids, now including the re-mention)
    // is unchanged.
    projections.clearProjections();
    const marcusIdAfterRebuild = insertEntity("Marcus", [msg.id, remention.id]);
    expect(marcusIdAfterRebuild).not.toBe(marcusIdBeforeRebuild);

    const candidates = findEligibleCircleBackCandidates(eventLog, projections, PRIMARY_USER_ID, "just a regular update");

    expect(candidates).toEqual([{ entityId: marcusIdAfterRebuild, name: "Marcus", attemptNumber: 2, mentionAgeLabel: expect.any(String), stableKey: msg.id }]);
  });

  it("hard cap: a third attempt is never offered, even after another genuine re-mention", () => {
    const msg = userTurn("Marcus helped me carry some boxes.");
    const marcusId = insertEntity("Marcus", [msg.id]);
    const firstFireTurn = userTurn("first attempt fires here");
    recordCircleBackFired(firstFireTurn.id, marcusId, "Marcus", msg.id);
    userTurn("direct reply");
    const remention1 = userTurn("Marcus again.");
    projections.touchEntity(marcusId, [remention1.id], "message-v1");
    for (let i = 0; i < 5; i++) userTurn(`filler ${i}`);
    const secondFireTurn = userTurn("second attempt fires here");
    recordCircleBackFired(secondFireTurn.id, marcusId, "Marcus", msg.id);
    userTurn("direct reply 2");
    const remention2 = userTurn("Marcus yet again.");
    projections.touchEntity(marcusId, [remention2.id], "message-v1");
    for (let i = 0; i < 5; i++) userTurn(`more filler ${i}`);

    const candidates = findEligibleCircleBackCandidates(eventLog, projections, PRIMARY_USER_ID, "just a regular update");

    expect(candidates.map((c) => c.name)).not.toContain("Marcus");
  });

  it("priority: a fresh, recency-eligible candidate is offered alone, even when a re-mention-eligible second-attempt candidate also exists", () => {
    const marcusMsg = userTurn("Marcus helped me carry some boxes.");
    const marcusId = insertEntity("Marcus", [marcusMsg.id]);
    const firstFireTurn = userTurn("first attempt on Marcus fires here");
    recordCircleBackFired(firstFireTurn.id, marcusId, "Marcus", marcusMsg.id);
    userTurn("direct reply");
    const remention = userTurn("Marcus came up again.");
    projections.touchEntity(marcusId, [remention.id], "message-v1");
    for (let i = 0; i < 3; i++) userTurn(`filler ${i}`); // clears cooldown, Marcus now second-attempt-eligible

    // A brand new person, freshly mentioned, also becomes a candidate this turn.
    const priyaMsg = userTurn("Ran into Priya at the store today.");
    const priyaId = insertEntity("Priya", [priyaMsg.id]);

    const candidates = findEligibleCircleBackCandidates(eventLog, projections, PRIMARY_USER_ID, "just a regular update");

    expect(candidates).toEqual([{ entityId: priyaId, name: "Priya", attemptNumber: 1, mentionAgeLabel: expect.any(String), stableKey: priyaMsg.id }]);
  });
});

describe("Candidate rotation and weighting (breadth-before-depth batch, item 3)", () => {
  it("weighting: an entity only ever mentioned bundled in a roster ranks below one the owner returned to on their own", () => {
    // Roster turn: five names dropped in one message — intake, not interest (each name's elaboration is diluted by density).
    const roster = userTurn("My cousins are Priya, Sam, Alex, Jordan, and Riley.");
    insertEntity("Priya", [roster.id]);
    insertEntity("Sam", [roster.id]);
    insertEntity("Alex", [roster.id]);
    insertEntity("Jordan", [roster.id]);
    const rileyId = insertEntity("Riley", [roster.id]);

    // Returned-to: mentioned once in the roster, then brought up again unprompted, with real detail, in a later, separate turn.
    const secondMention = userTurn("Riley actually just started a new job and seems a lot happier lately.");
    projections.touchEntity(rileyId, [secondMention.id], "message-v1");

    const candidates = findEligibleCircleBackCandidates(eventLog, projections, PRIMARY_USER_ID, "just a regular update");
    const names = candidates.map((c) => c.name);

    expect(names[0]).toBe("Riley");
    expect(names.indexOf("Riley")).toBeLessThan(names.indexOf("Priya"));
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

  it("first attempt tells Enso this is its ONLY unprompted ask, never to raise it again unless the user re-mentions it", () => {
    expect(buildCircleBackDirective("Marcus", 1)).toMatch(/ONLY unprompted ask/);
  });

  it("second attempt is framed around the name coming back up, not elapsed time", () => {
    const directive = buildCircleBackDirective("Marcus", 2, "a while back");
    expect(directive).toMatch(/mentioned "Marcus" again/);
    expect(directive).toMatch(/is that the same Marcus/);
  });
});
