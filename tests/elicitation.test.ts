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
  THIN_POOL_ANCHOR_THRESHOLD,
  verifyElicitationExecuted,
  wasTopicDismissed
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

function establishAsSpouse(entityId: string) {
  projections.insertStructuralAtom({
    id: newId(),
    user_id: PRIMARY_USER_ID,
    type: "spouse_of",
    from_entity_id: entityId,
    to_entity_id: primaryEntityId(PRIMARY_USER_ID),
    basis: "stated",
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

describe("Candidate rotation and weighting (breadth-before-depth batch, item 3)", () => {
  it("rotation: an anchor just asked about (any probe type) yields the floor even though it would otherwise still win on recency alone", () => {
    // Elena established FIRST — under the old "most-recently-mentioned wins" rule alone, she'd rank behind Marcus below.
    const msgElena = userTurn("My friend Elena and I grabbed coffee yesterday.");
    const elenaId = insertEntity("Elena", [msgElena.id]);
    establishAsFriend(elenaId);

    // Marcus established SECOND, and is the same live shape as the real bug: just asked about (howMet fired),
    // yet remains the "most recently mentioned" anchor — the exact condition that let one anchor monopolize every
    // Layer 3 selection before this fix, since recency alone would keep re-selecting him regardless of the ask.
    const msgMarcus = userTurn("My friend Marcus helped me move a couch.");
    const marcusId = insertEntity("Marcus", [msgMarcus.id]);
    establishAsFriend(marcusId);
    const askTurn = userTurn("filler turn between the ask and the next selection");
    recordReply(askTurn.id, { elicitationFired: { layer: 3, probeType: "howMet", anchorEntityId: marcusId, anchorStableKey: msgMarcus.id } });

    const next = findLayer3Candidate(eventLog, projections, PRIMARY_USER_ID);

    expect(next?.layer).toBe(3);
    expect(next && next.layer === 3 ? next.anchorName : null).toBe("Elena");
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

describe("wasTopicDismissed (production bug batch, item 1a: dismissal persists cross-session; EN-126 item 4: adjacent-turn matching + re-mention reopens)", () => {
  it("false when nothing in the log mentions the anchor at all", () => {
    expect(wasTopicDismissed(eventLog, PRIMARY_USER_ID, "Annissa", [])).toBe(false);
  });

  it("false when the anchor is mentioned but never alongside a dismissal-shaped phrase", () => {
    userTurn("Annissa and I met up for lunch again today.");
    expect(wasTopicDismissed(eventLog, PRIMARY_USER_ID, "Annissa", [])).toBe(false);
  });

  it("false when a dismissal phrase appears but never in the same or immediately preceding turn as the anchor's name", () => {
    userTurn("Please drop it for now, I'm tired.");
    userTurn("Anyway, work has been busy.");
    expect(wasTopicDismissed(eventLog, PRIMARY_USER_ID, "Annissa", [])).toBe(false);
  });

  it("true when the user's own turn names the anchor and pushes back explicitly", () => {
    userTurn("You keep asking about how I met Annissa — can we drop it?");
    expect(wasTopicDismissed(eventLog, PRIMARY_USER_ID, "Annissa", [])).toBe(true);
  });

  it("true when it's ENSO's own reply that self-corrects and names the anchor — the self-corrected-repetition case, not just explicit user dismissal", () => {
    const msg = userTurn("How did you and Naveen meet again?");
    recordReply(msg.id, {});
    eventLog.append({ type: "reply_sent", actor: "enso", payload: { text: "You're right, I keep circling back to how you and Naveen met — I'll leave it alone.", inReplyToEventId: msg.id }, userId: PRIMARY_USER_ID });
    expect(wasTopicDismissed(eventLog, PRIMARY_USER_ID, "Naveen", [])).toBe(true);
  });

  it("dismissing one anchor's topic never silences curiosity about a DIFFERENT anchor", () => {
    userTurn("You keep asking about Annissa's origin story, drop it.");
    expect(wasTopicDismissed(eventLog, PRIMARY_USER_ID, "Annissa", [])).toBe(true);
    expect(wasTopicDismissed(eventLog, PRIMARY_USER_ID, "Marcus", [])).toBe(false);
  });

  it("EN-126: a dismissal signal referring to the anchor by PRONOUN (no name in the same message) still registers, via the immediately preceding turn naming them", () => {
    const opener = eventLog.append({ type: "reply_sent", actor: "enso", payload: { text: "Have you talked to Annissa lately?", inReplyToEventId: null }, userId: PRIMARY_USER_ID });
    void opener;
    userTurn("why are you ask about her again?");
    expect(wasTopicDismissed(eventLog, PRIMARY_USER_ID, "Annissa", [])).toBe(true);
  });

  it("EN-126: the literal phrase from the live transcript, 'stop bringing X up', is recognized", () => {
    userTurn("Can you stop bringing Annissa up? I've told you before.");
    expect(wasTopicDismissed(eventLog, PRIMARY_USER_ID, "Annissa", [])).toBe(true);
  });

  it("EN-126: re-mention reopens — a dismissal followed by the USER mentioning the anchor again later lifts it", () => {
    userTurn("Stop bringing Annissa up, please.");
    const remention = userTurn("Actually, funny story — Annissa called me today.");
    expect(wasTopicDismissed(eventLog, PRIMARY_USER_ID, "Annissa", [remention.id])).toBe(false);
  });

  it("EN-126: re-mention BEFORE the dismissal does not reopen a LATER dismissal — only a re-mention strictly after the most recent dismissal counts", () => {
    const earlyMention = userTurn("Annissa and I grabbed coffee.");
    userTurn("Stop bringing Annissa up, please.");
    expect(wasTopicDismissed(eventLog, PRIMARY_USER_ID, "Annissa", [earlyMention.id])).toBe(true);
  });
});

describe("findLayer3Candidate honors topic dismissal, and it persists past what any single session would hold (production bug batch, item 1a)", () => {
  it("a dismissed anchor's Layer 3 probing is excluded even for probe types that never fired — not just the one probe that was asked", () => {
    const msg = userTurn("My friend Annissa and I have known each other for years.");
    const annissaId = insertEntity("Annissa", [msg.id]);
    establishAsFriend(annissaId);
    // howMet fired once (structurally capped already), then the owner explicitly dismissed the whole topic —
    // a real live transcript would have several more organic (ungated) asks between these two turns.
    const askTurn = userTurn("filler between the ask and the dismissal");
    recordReply(askTurn.id, { elicitationFired: { layer: 3, probeType: "howMet", anchorEntityId: annissaId, anchorStableKey: msg.id } });
    userTurn("You keep asking about Annissa's story — I told you to leave it alone.");

    // Directly exercising findLayer3Candidate with an otherwise-single-anchor archive: were dismissal not
    // honored, earliestMemory (the next unasked probe type in LAYER3_PROBE_TYPES) would still be offered.
    const candidate = findLayer3Candidate(eventLog, projections, PRIMARY_USER_ID);
    expect(candidate).toBeNull();
  });

  it("reproduces the real failure shape: dismissed mid-session, a FRESH call (simulating the next session's opener, no session-scoped state anywhere in this function) never re-offers that anchor", () => {
    const msg = userTurn("My friend Annissa and I have known each other for years.");
    const annissaId = insertEntity("Annissa", [msg.id]);
    establishAsFriend(annissaId);
    userTurn("Enough about how Annissa and I met, please drop it.");

    // No session boundary concept exists anywhere in this call — it derives purely from the full event
    // log every time, which is exactly what makes the dismissal survive into a later, independent call.
    const nextSessionCandidate = findLayer3Candidate(eventLog, projections, PRIMARY_USER_ID);
    expect(nextSessionCandidate?.layer === 3 ? nextSessionCandidate.anchorEntityId : null).not.toBe(annissaId);
  });
});

describe("findElicitationCandidate: thin candidate pool forces breadth over depth (production bug batch, item 1b)", () => {
  it("a single established anchor covering MULTIPLE domains by relation type alone (spouse: family + partnership, plus occupation for work) still yields Layer 1, not Layer 3 — domainCoverage's binary signal alone would have picked Layer 3 here", () => {
    const msg = userTurn("My spouse and I talked about it.");
    const spouseId = insertEntity("Alex", [msg.id]);
    establishAsSpouse(spouseId);
    projections.insertEntityAttribute({
      id: newId(),
      user_id: PRIMARY_USER_ID,
      entity_id: primaryEntityId(PRIMARY_USER_ID),
      attribute: "occupation",
      value: "engineer",
      source_event_ids: JSON.stringify(["seed"]),
      created_at: new Date().toISOString()
    });

    // Confirms the premise: only closeFriendship is uncovered (count 1), so the OLD domainCoverage-only
    // tiebreak (uncovered >= 2 ? layer1 : layer3) would have picked layer3 here.
    const coverage = domainCoverage(projections, PRIMARY_USER_ID);
    expect(coverage).toEqual({ work: true, family: true, closeFriendship: false, partnership: true, homePlace: false });

    expect(THIN_POOL_ANCHOR_THRESHOLD).toBe(1);
    const candidate = findElicitationCandidate(eventLog, projections, PRIMARY_USER_ID);
    expect(candidate?.layer).toBe(1);
  });

  it("control: the SAME low-uncovered-domain shape with TWO established anchors is not thin, and keeps the ordinary domain-coverage tiebreak (Layer 3)", () => {
    const msg1 = userTurn("My spouse and I talked about it.");
    const spouseId = insertEntity("Alex", [msg1.id]);
    establishAsSpouse(spouseId);
    const msg2 = userTurn("My friend Marcus helped me move a couch.");
    const marcusId = insertEntity("Marcus", [msg2.id]);
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

    const candidate = findElicitationCandidate(eventLog, projections, PRIMARY_USER_ID);
    expect(candidate?.layer).toBe(3);
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
