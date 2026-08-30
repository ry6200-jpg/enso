import { beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/events/eventLog.js";
import { ProjectionsDb } from "../src/projections/db.js";
import { primaryEntityId } from "../src/projections/rebuild.js";
import { newId } from "../src/ids.js";
import { freshTestDbPath } from "../src/test/dbPath.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";
import {
  buildConnectDotDirective,
  buildSelfFactDirective,
  findCuriosityAskCandidates,
  findEligibleSelfFactCandidates,
  hasOpenLoop,
  isCuriosityTurnEligible,
  isWindingDown,
  MAX_SELF_FACT_ATTEMPTS,
  verifyCuriosityAskExecuted,
  verifySelfFactAskExecuted
} from "../src/conversation/circleBack.js";
import type { ReplySentPayload } from "../src/conversation/chatPipeline.js";
import type { RecentTurnForPrompt } from "../src/persona/systemPrompt.js";

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

function giveSelfAttribute(attribute: "birthdate" | "location" | "occupation", value: string) {
  projections.insertEntityAttribute({
    id: newId(),
    user_id: PRIMARY_USER_ID,
    entity_id: primaryEntityId(PRIMARY_USER_ID),
    attribute,
    value,
    source_event_ids: JSON.stringify(["seed"]),
    created_at: new Date().toISOString()
  });
}

function recordFired(inReplyToEventId: string, gateActions: Partial<ReplySentPayload["gateActions"]>) {
  const payload: Partial<ReplySentPayload> = {
    inReplyToEventId,
    gateActions: {
      circleBackFired: null,
      attestationConfirmedEventId: null,
      selfBirthdateAskFired: false,
      selfFactAskFired: null,
      connectDotFired: false,
      elicitationFired: null,
      coReferenceAskFired: null,
      coReferenceAnswerEventId: null,
      mergeProposalFired: null,
      mergeAnswerEventId: null,
      ...gateActions
    }
  };
  return eventLog.append({ type: "reply_sent", actor: "enso", payload, userId: PRIMARY_USER_ID });
}

describe("findEligibleSelfFactCandidates (EN-030 item A)", () => {
  it("offers occupation first when both occupation and location are unknown", () => {
    const candidates = findEligibleSelfFactCandidates(projections, eventLog, PRIMARY_USER_ID);
    expect(candidates).toEqual([{ kind: "selfFact", attribute: "occupation" }]);
  });

  it("falls through to location once occupation is known", () => {
    giveSelfAttribute("occupation", "engineer");
    const candidates = findEligibleSelfFactCandidates(projections, eventLog, PRIMARY_USER_ID);
    expect(candidates).toEqual([{ kind: "selfFact", attribute: "location" }]);
  });

  it("offers nothing once both are known", () => {
    giveSelfAttribute("occupation", "engineer");
    giveSelfAttribute("location", "Seattle");
    expect(findEligibleSelfFactCandidates(projections, eventLog, PRIMARY_USER_ID)).toEqual([]);
  });

  it("a one-shot cap — a fired-and-verified occupation ask is never offered again even though it's still technically unknown", () => {
    expect(MAX_SELF_FACT_ATTEMPTS).toBe(1);
    const turn = userTurn("some update");
    recordFired(turn.id, { selfFactAskFired: { attribute: "occupation" } });

    const candidates = findEligibleSelfFactCandidates(projections, eventLog, PRIMARY_USER_ID);
    expect(candidates).toEqual([{ kind: "selfFact", attribute: "location" }]);
  });
});

describe("findCuriosityAskCandidates (EN-030 item A: self-fact outranks third-party, unchanged priority)", () => {
  it("offers the self-fact gap and suppresses an otherwise-eligible third-party candidate entirely", () => {
    const msg = userTurn("My coworker Marcus helped me move a couch.");
    insertEntity("Marcus", [msg.id]);

    const candidates = findCuriosityAskCandidates(eventLog, projections, PRIMARY_USER_ID, "just a regular update");

    expect(candidates).toEqual([{ kind: "selfFact", attribute: "occupation" }]);
  });

  it("falls through to third-party candidates once all self-facts are known", () => {
    giveSelfAttribute("occupation", "engineer");
    giveSelfAttribute("location", "Seattle");
    const msg = userTurn("My coworker Marcus helped me move a couch.");
    insertEntity("Marcus", [msg.id]);

    const candidates = findCuriosityAskCandidates(eventLog, projections, PRIMARY_USER_ID, "just a regular update");

    expect(candidates).toEqual([{ kind: "thirdParty", candidate: expect.objectContaining({ name: "Marcus" }) }]);
  });
});

describe("isWindingDown (EN-030 item B discriminator) — the two real transcript fixtures", () => {
  // Verbatim from dev-data/events.db (2026-08-21 session), read directly
  // rather than worked from a summary, per the design brief.
  const stillOpenWindow: RecentTurnForPrompt[] = [
    { role: "user", text: "but I did not ask for your help" },
    { role: "enso", text: "I jumped in with advice you didn't ask for. I should have listened and stayed with what you were telling me. Sorry, Richard." }
  ];
  const windingDownWindow: RecentTurnForPrompt[] = [
    { role: "user", text: "I am exhausted spending a lot time on it" },
    { role: "enso", text: "Yeah—this is draining you now, not just taking time. Put it down for today; the work will still be there when you have more of yourself back." }
  ];

  it("case 1 (still open): a forgiven misstep carries no depletion or permission-to-stop language — Enso SHOULD have taken the turn on the next reply", () => {
    expect(isWindingDown(stillOpenWindow)).toBe(false);
  });

  it("case 2 (winding down): explicit exhaustion from the user plus Enso's own permission-to-stop language — Enso correctly did NOT take the turn on the next reply", () => {
    expect(isWindingDown(windingDownWindow)).toBe(true);
  });

  it("silence/short-reply length alone is not the discriminator — an empty window is NOT treated as winding down", () => {
    expect(isWindingDown([])).toBe(false);
  });
});

describe("hasOpenLoop (EN-030 item B's other precondition) — revised after live testing", () => {
  it("an empty event log has no open loop", () => {
    expect(hasOpenLoop(eventLog, PRIMARY_USER_ID)).toBe(false);
  });

  it("an ORGANIC question (no gate fired) is NOT an open loop — the original 'ends in ?' implementation over-suppressed on exactly this case, caught live: ordinary curious replies almost always end in a question, which isn't 'Enso has something outstanding'", () => {
    const t = userTurn("some update");
    recordFired(t.id, {}); // no gate fired; the reply text itself is irrelevant now — gateActions is what's checked
    expect(hasOpenLoop(eventLog, PRIMARY_USER_ID)).toBe(false);
  });

  it("a genuine gate-directed ask (third-party) that hasn't been resolved yet IS an open loop", () => {
    const t = userTurn("My coworker Marcus helped me move.");
    recordFired(t.id, { circleBackFired: { entityId: "x", name: "Marcus", stableKey: "x" } });
    expect(hasOpenLoop(eventLog, PRIMARY_USER_ID)).toBe(true);
  });

  it("a self-birthdate ask counts as an open loop too — deliberately checked here even though it's excluded from the shared cooldown scan", () => {
    const t = userTurn("hi");
    recordFired(t.id, { selfBirthdateAskFired: true });
    expect(hasOpenLoop(eventLog, PRIMARY_USER_ID)).toBe(true);
  });

  it("an elicitation probe counts as an open loop too", () => {
    const t = userTurn("just a regular day");
    recordFired(t.id, { elicitationFired: { layer: 1, probeType: "call2am" } });
    expect(hasOpenLoop(eventLog, PRIMARY_USER_ID)).toBe(true);
  });

  it("connectDot does NOT count as an open loop — it's an observation, not a question awaiting an answer", () => {
    const t = userTurn("just a regular day");
    recordFired(t.id, { connectDotFired: true });
    expect(hasOpenLoop(eventLog, PRIMARY_USER_ID)).toBe(false);
  });
});

describe("isCuriosityTurnEligible (EN-030 item B, composed) — acceptance bar: both real transcript cases", () => {
  it("case 1 (still open, no open loop, current message not a question): eligible", () => {
    const recentTurns: RecentTurnForPrompt[] = [
      { role: "user", text: "but I did not ask for your help" },
      { role: "enso", text: "I jumped in with advice you didn't ask for. I should have listened and stayed with what you were telling me. Sorry, Richard." }
    ];
    expect(isCuriosityTurnEligible(eventLog, PRIMARY_USER_ID, "that's ok", recentTurns)).toBe(true);
  });

  it("case 2 (winding down): NOT eligible, regardless of no open loop", () => {
    const recentTurns: RecentTurnForPrompt[] = [
      { role: "user", text: "I am exhausted spending a lot time on it" },
      { role: "enso", text: "Yeah—this is draining you now, not just taking time. Put it down for today; the work will still be there when you have more of yourself back." }
    ];
    expect(isCuriosityTurnEligible(eventLog, PRIMARY_USER_ID, "maybe", recentTurns)).toBe(false);
  });

  it("the current message itself being a question suppresses eligibility, same restraint as the pre-existing gates", () => {
    expect(isCuriosityTurnEligible(eventLog, PRIMARY_USER_ID, "what do you think about that?", [])).toBe(false);
  });

  it("a curiosity-turn fire of ANY kind within the cooldown window suppresses eligibility for a fresh, unrelated turn", () => {
    const turn = userTurn("some update");
    recordFired(turn.id, { connectDotFired: true });

    expect(isCuriosityTurnEligible(eventLog, PRIMARY_USER_ID, "another update", [])).toBe(false);
  });
});

describe("buildSelfFactDirective / verifySelfFactAskExecuted", () => {
  it("location directive asks toward where the owner lives, never database-style", () => {
    const directive = buildSelfFactDirective("location");
    expect(directive).toMatch(/where the owner is based or living/);
    expect(directive).toMatch(/never as a direct database-style question/);
  });

  it("verifies a location ask actually appeared in the reply", () => {
    expect(verifySelfFactAskExecuted("location", "By the way, where do you live these days?")).toBe(true);
    expect(verifySelfFactAskExecuted("location", "That sounds like a busy week.")).toBe(false);
  });

  it("verifies an occupation ask actually appeared in the reply", () => {
    expect(verifySelfFactAskExecuted("occupation", "Out of curiosity, what do you do for work?")).toBe(true);
    expect(verifySelfFactAskExecuted("occupation", "That sounds like a busy week.")).toBe(false);
  });

  it("verifyCuriosityAskExecuted dispatches selfFact candidates to the same check", () => {
    expect(verifyCuriosityAskExecuted({ kind: "selfFact", attribute: "occupation" }, "What do you do for work?")).toBe(true);
  });
});

describe("buildConnectDotDirective (CONNECTING BEATS ASKING — first class, not a fallback)", () => {
  it("tells Enso to lead with a connection, defers WHAT to BE ANALYTICAL, and forbids forcing one that isn't there", () => {
    const directive = buildConnectDotDirective();
    expect(directive).toMatch(/look for ONE real connecting observation/);
    expect(directive).toMatch(/don't force a connection that isn't really there/);
    expect(directive).toMatch(/not a license to write a longer reply/);
  });
});
