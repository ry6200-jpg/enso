import { beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/events/eventLog.js";
import { ProjectionsDb } from "../src/projections/db.js";
import { primaryEntityId } from "../src/projections/rebuild.js";
import { newId } from "../src/ids.js";
import { freshTestDbPath } from "../src/test/dbPath.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";
import {
  buildElicitationDirective,
  domainCoverage,
  findElicitationCandidate,
  findLayer3Candidate,
  justOpenedUpFromElicitation,
  LAYER1_PROBE_TYPES,
  LAYER3_PROBE_TYPES,
  MAX_LAYER1_ATTEMPTS_PER_PROBE_TYPE,
  verifyElicitationExecuted
} from "../src/conversation/elicitation.js";
import { findCuriosityAskCandidates, isCuriosityTurnEligible } from "../src/conversation/circleBack.js";
import { isSelfBirthdateEligible } from "../src/conversation/selfBirthdateGate.js";
import type { ReplySentPayload } from "../src/conversation/chatPipeline.js";

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

function establishAsFriend(entityId: string) {
  projections.insertSocialBond({
    id: newId(),
    user_id: PRIMARY_USER_ID,
    type: "friend",
    from_entity_id: entityId,
    to_entity_id: primaryEntityId(PRIMARY_USER_ID),
    qualifier: null,
    opened_basis: "stated",
    interval_start: null,
    interval_end: null,
    source_event_ids: JSON.stringify([]),
    created_at: new Date().toISOString()
  });
}

function recordReply(inReplyToEventId: string, gateActions: Partial<ReplySentPayload["gateActions"]>) {
  const payload: Partial<ReplySentPayload> = {
    inReplyToEventId,
    gateActions: { circleBackFired: null, attestationConfirmedEventId: null, selfBirthdateAskFired: false, selfFactAskFired: null, connectDotFired: false, elicitationFired: null, ...gateActions }
  };
  return eventLog.append({ type: "reply_sent", actor: "enso", payload, userId: PRIMARY_USER_ID });
}

describe("EN-097 acceptance fixture: thin thread, shallow archive -> Layer 1 probe, never an intimate (Layer 3) probe", () => {
  it("an empty archive yields a Layer 1 candidate — no anchor exists yet, so Layer 3 cannot possibly fire", () => {
    const candidate = findElicitationCandidate(eventLog, projections, PRIMARY_USER_ID);
    expect(candidate).toEqual({ kind: "elicitation", layer: 1, probeType: LAYER1_PROBE_TYPES[0] });
  });

  it("Layer 1 fires with NO coverage dependency at all — still eligible even when self-facts are already known (not gated on domain tracking, per explicit correction)", () => {
    projections.insertEntityAttribute({
      id: newId(),
      user_id: PRIMARY_USER_ID,
      entity_id: primaryEntityId(PRIMARY_USER_ID),
      attribute: "occupation",
      value: "engineer",
      source_event_ids: JSON.stringify(["seed"]),
      created_at: new Date().toISOString()
    });
    const candidate = findElicitationCandidate(eventLog, projections, PRIMARY_USER_ID);
    expect(candidate?.layer).toBe(1);
  });
});

describe("EN-097 acceptance fixture: thin thread, depleted user -> nothing fires", () => {
  it("isCuriosityTurnEligible is false when winding down, so the whole axis (including elicitation) never even gets offered", () => {
    const recentTurns = [
      { role: "user" as const, text: "I am exhausted spending a lot of time on it" },
      { role: "enso" as const, text: "Yeah, this is draining you. Put it down for today." }
    ];
    expect(isCuriosityTurnEligible(eventLog, PRIMARY_USER_ID, "maybe", recentTurns)).toBe(false);
    // chatPipeline.ts only calls findCuriosityAskCandidates when eligible — verifying the upstream gate is what actually protects this, matching the existing EN-030 short-circuit pattern.
  });
});

describe("EN-097 THE FAILURE MODE TO GUARD HARDEST: user opens up -> continuer, NOT another probe", () => {
  it("a substantive answer right after an elicitation probe suppresses the whole curiosity-turn axis this turn", () => {
    const probeTurn = userTurn("just a regular day");
    recordReply(probeTurn.id, { elicitationFired: { layer: 1, probeType: "call2am" } });

    const substantiveAnswer = "Honestly it would probably be my sister Elena, she's the one who always picks up no matter what time it is and never makes me feel bad for calling.";
    expect(justOpenedUpFromElicitation(eventLog, PRIMARY_USER_ID, substantiveAnswer)).toBe(true);
    expect(isCuriosityTurnEligible(eventLog, PRIMARY_USER_ID, substantiveAnswer, [])).toBe(false);
  });

  it("a short, non-substantive answer does NOT trigger the continuer suppression — still eligible to probe again if otherwise warranted", () => {
    const probeTurn = userTurn("just a regular day");
    recordReply(probeTurn.id, { elicitationFired: { layer: 1, probeType: "call2am" } });

    expect(justOpenedUpFromElicitation(eventLog, PRIMARY_USER_ID, "not sure")).toBe(false);
  });

  it("the suppression only triggers off an elicitation fire, not other gate kinds (scoped exactly as specified)", () => {
    const probeTurn = userTurn("My coworker Marcus helped me move a couch.");
    recordReply(probeTurn.id, { circleBackFired: { entityId: "x", name: "Marcus", stableKey: "x" } });

    expect(justOpenedUpFromElicitation(eventLog, PRIMARY_USER_ID, "he's a great guy, known him for years now and he always shows up when it matters")).toBe(false);
  });
});

describe("EN-097 acceptance fixture: anchor exists -> Layer 3 available; no anchor -> unavailable", () => {
  it("no established entity at all -> Layer 3 never offered, only Layer 1", () => {
    const msg = userTurn("My coworker Marcus helped me move a couch.");
    insertEntity("Marcus", [msg.id]); // mentioned, but NOT established (no social bond/structural atom)

    const candidate = findElicitationCandidate(eventLog, projections, PRIMARY_USER_ID);
    expect(candidate?.layer).toBe(1);
  });

  it("an established entity unlocks Layer 3 once Layer 1 is fully exhausted (breadth before depth)", () => {
    const msg = userTurn("My friend Marcus helped me move a couch.");
    const marcusId = insertEntity("Marcus", [msg.id]);
    establishAsFriend(marcusId);

    // Exhaust all six Layer 1 subtypes so the breadth-first tiebreak can resolve to Layer 3.
    expect(MAX_LAYER1_ATTEMPTS_PER_PROBE_TYPE).toBe(1);
    let turnCounter = 0;
    for (const probeType of LAYER1_PROBE_TYPES) {
      const t = userTurn(`filler ${turnCounter++}`);
      recordReply(t.id, { elicitationFired: { layer: 1, probeType } });
    }

    const candidate = findElicitationCandidate(eventLog, projections, PRIMARY_USER_ID);
    expect(candidate).toEqual({ kind: "elicitation", layer: 3, probeType: LAYER3_PROBE_TYPES[0], anchorEntityId: marcusId, anchorName: "Marcus", anchorStableKey: msg.id });
  });
});

describe("R44: Layer 3's attempt cap keys on the anchor's stable id, not the ephemeral projection entityId", () => {
  it("real-transcript case: the SAME anchor reassigned a new projection entityId on every rebuild (EN-054) must not look like a fresh candidate — only the underlying gap's first fire counts, however many times the entity was re-inserted under a new id", () => {
    const msg = userTurn("I went to Saigon in May to visit a childhood friend.");
    const stableKey = msg.id; // the anchor's earliest provenance event — stable across every rebuild below

    // Turn 1: the anchor exists under entityId A, and the first Layer 3 "howMet" ask fires and is recorded against the real stable key.
    const entityIdA = insertEntity("Childhood Friend", [stableKey]);
    establishAsFriend(entityIdA);
    recordReply(msg.id, { elicitationFired: { layer: 3, probeType: "howMet", anchorEntityId: entityIdA, anchorStableKey: stableKey } });

    // Turns 2-5: four more rebuilds, each reassigning a brand-new entityId to the SAME real person (same source_event_ids, same stableKey) —
    // reproducing the real live failure (three distinct anchorEntityIds recorded for one real childhood friend across a single session).
    for (let i = 0; i < 4; i++) {
      projections = new ProjectionsDb(freshTestDbPath(import.meta.url, `projections-rebuild-${i}`));
      const churnedEntityId = insertEntity("Childhood Friend", [stableKey]);
      establishAsFriend(churnedEntityId);

      // Test findLayer3Candidate directly, not the full orchestrator: with an otherwise-empty archive, Layer 2's
      // breadth-first tiebreak would prefer Layer 1 regardless of whether this bug is present or fixed, masking the result.
      const candidate = findLayer3Candidate(eventLog, projections, PRIMARY_USER_ID);
      const layer3Reoffered = candidate?.layer === 3 && candidate.probeType === "howMet";
      expect(layer3Reoffered).toBe(false);
    }
  });
});

describe("domainCoverage (Layer 2 — 5 derivable domains only, per explicit scoping)", () => {
  it("starts fully uncovered on an empty archive", () => {
    expect(domainCoverage(projections, PRIMARY_USER_ID)).toEqual({ work: false, family: false, closeFriendship: false, partnership: false, homePlace: false });
  });

  it("occupation attribute marks work covered; a friend bond marks closeFriendship covered", () => {
    const msg = userTurn("My friend Marcus helped me move.");
    const marcusId = insertEntity("Marcus", [msg.id]);
    establishAsFriend(marcusId);
    projections.insertEntityAttribute({
      id: newId(),
      user_id: PRIMARY_USER_ID,
      entity_id: primaryEntityId(PRIMARY_USER_ID),
      attribute: "occupation",
      value: "engineer",
      source_event_ids: JSON.stringify(["seed"]),
      created_at: new Date().toISOString()
    });

    const coverage = domainCoverage(projections, PRIMARY_USER_ID);
    expect(coverage.work).toBe(true);
    expect(coverage.closeFriendship).toBe(true);
    expect(coverage.family).toBe(false);
    expect(coverage.partnership).toBe(false);
  });
});

describe("buildElicitationDirective / verifyElicitationExecuted", () => {
  it("Layer 1 directive names the concept, never a literal template, and explicitly allows offering directions on a thin thread", () => {
    const directive = buildElicitationDirective({ kind: "elicitation", layer: 1, probeType: "call2am" });
    expect(directive).toMatch(/who they'd call if something went wrong at 2am/);
    expect(directive).toMatch(/name a couple of possible directions and let them pick/);
    expect(directive).toMatch(/opening a door, not collecting an answer/);
  });

  it("Layer 3 directive names the anchor and the scene concept", () => {
    const directive = buildElicitationDirective({ kind: "elicitation", layer: 3, probeType: "howMet", anchorEntityId: "e1", anchorName: "Marcus", anchorStableKey: "e1-stable" });
    expect(directive).toMatch(/Marcus/);
    expect(directive).toMatch(/how they first met this person/);
  });

  it("verification requires a real question; Layer 3 also requires the anchor's name to appear", () => {
    expect(verifyElicitationExecuted({ kind: "elicitation", layer: 1, probeType: "goodNews" }, "Who would you tell first?")).toBe(true);
    expect(verifyElicitationExecuted({ kind: "elicitation", layer: 1, probeType: "goodNews" }, "That sounds nice.")).toBe(false);
    expect(verifyElicitationExecuted({ kind: "elicitation", layer: 3, probeType: "howMet", anchorEntityId: "e1", anchorName: "Marcus", anchorStableKey: "e1-stable" }, "How did you and Marcus first meet?")).toBe(true);
    expect(verifyElicitationExecuted({ kind: "elicitation", layer: 3, probeType: "howMet", anchorEntityId: "e1", anchorName: "Marcus", anchorStableKey: "e1-stable" }, "How did you two first meet?")).toBe(false);
  });
});

describe("EN-097 priority: selfFact > thirdParty > elicitation, unchanged discipline extended", () => {
  it("self-birthdate outranks elicitation exactly like it outranks third-party — findCuriosityAskCandidates is never even reached", () => {
    expect(isSelfBirthdateEligible(eventLog, projections, PRIMARY_USER_ID, "hello")).toBe(true);
    // Mirrors chatPipeline.ts's own short-circuit: curiosityCandidates stays [] whenever selfBirthdateEligible is true, elicitation included.
  });

  it("an eligible third-party candidate outranks elicitation in the unified pool", () => {
    projections.insertEntityAttribute({
      id: newId(),
      user_id: PRIMARY_USER_ID,
      entity_id: primaryEntityId(PRIMARY_USER_ID),
      attribute: "birthdate",
      value: "1970-04-24",
      source_event_ids: JSON.stringify(["seed"]),
      created_at: new Date().toISOString()
    });
    projections.insertEntityAttribute({
      id: newId(),
      user_id: PRIMARY_USER_ID,
      entity_id: primaryEntityId(PRIMARY_USER_ID),
      attribute: "occupation",
      value: "engineer",
      source_event_ids: JSON.stringify(["seed"]),
      created_at: new Date().toISOString()
    });
    projections.insertEntityAttribute({
      id: newId(),
      user_id: PRIMARY_USER_ID,
      entity_id: primaryEntityId(PRIMARY_USER_ID),
      attribute: "location",
      value: "Seattle",
      source_event_ids: JSON.stringify(["seed"]),
      created_at: new Date().toISOString()
    });
    const msg = userTurn("My coworker Marcus helped me move a couch.");
    insertEntity("Marcus", [msg.id]);

    const candidates = findCuriosityAskCandidates(eventLog, projections, PRIMARY_USER_ID, "just a regular update");
    expect(candidates).toEqual([{ kind: "thirdParty", candidate: expect.objectContaining({ name: "Marcus" }) }]);
  });
});
