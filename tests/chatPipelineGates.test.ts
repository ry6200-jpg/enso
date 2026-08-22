import { beforeEach, describe, expect, it } from "vitest";
import { sendMessage, type ReplySentPayload, type SendMessageDeps } from "../src/conversation/chatPipeline.js";
import { EventLog } from "../src/events/eventLog.js";
import { ProjectionsDb } from "../src/projections/db.js";
import { RetrievalDb } from "../src/retrieval/retrievalDb.js";
import type { ChatRouter } from "../src/providers/chatRouter.js";
import type { ChatCallResult } from "../src/providers/chatTypes.js";
import type { IntentRouter, RouterResult } from "../src/conversation/router/intentRouter.js";
import { SAFE_DEFAULT_DECISION, type RouterDecision } from "../src/conversation/router/routerTypes.js";
import { EMBEDDING_DIMENSIONS, type Embedder } from "../src/embeddings/embedder.js";
import { newId } from "../src/ids.js";
import { primaryEntityId } from "../src/projections/rebuild.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";

/**
 * Item 1/EN-030 item A: self-fact establishment (birthdate, and now the
 * generalized location/occupation pair) outranks third-party circle-back
 * whenever any of them isn't known yet — tests isolating THIRD-PARTY
 * circle-back behavior give the primary user all three stored so that
 * priority never shadows what's actually being tested here.
 */
function givePrimaryUserSelfFactsKnown(projections: ProjectionsDb): void {
  for (const [attribute, value] of [
    ["birthdate", "1970-04-24"],
    ["location", "Seattle"],
    ["occupation", "engineer"]
  ] as const) {
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
}

const CANNED_REPLY: ChatCallResult = { provider: "openai", model: "gpt-5.6-sol", text: "Noted.", usage: { inputTokens: 10, outputTokens: 5 } };

function fakeChatRouter(replyText = "Noted."): ChatRouter {
  return { async reply() { return { ...CANNED_REPLY, text: replyText }; } };
}

const fakeEmbedder: Embedder = {
  async embed() { return new Float32Array(EMBEDDING_DIMENSIONS); },
  modelId: "fake",
  dimensions: EMBEDDING_DIMENSIONS
};

function fakeIntentRouter(result: Partial<RouterResult> & { decision: RouterDecision }): IntentRouter {
  return {
    async route() {
      return { provider: "openai", model: "gpt-5.6-terra", certified: true, failureReason: null, ...result };
    }
  };
}

function decisionWith(overrides: Partial<RouterDecision> = {}): RouterDecision {
  return structuredClone({ ...SAFE_DEFAULT_DECISION, ...overrides });
}

let eventLog: EventLog;
let retrievalDb: RetrievalDb;
let projectionsDb: ProjectionsDb;
let deps: SendMessageDeps;

beforeEach(() => {
  eventLog = new EventLog(":memory:");
  retrievalDb = new RetrievalDb(":memory:");
  projectionsDb = new ProjectionsDb(":memory:");
  deps = { eventLog, retrievalDb, projectionsDb, embedder: fakeEmbedder, chatRouter: fakeChatRouter() };
});

describe("sendMessage — backward compatibility (no intentRouter configured)", () => {
  it("falls back to the Part 1 local heuristic and records router.used=false", async () => {
    const result = await sendMessage(deps, { userId: PRIMARY_USER_ID, text: "hello", recentTurns: [] });

    const payload = result.replyEvent.payload as ReplySentPayload;
    expect(payload.router.used).toBe(false);
    expect(payload.router.provider).toBeNull();
    expect(payload.gateActions).toEqual({ circleBackFired: null, attestationConfirmedEventId: null, selfBirthdateAskFired: false, selfFactAskFired: null, connectDotFired: false, elicitationFired: null });
  });
});

describe("sendMessage — router fail-safe path (verification item 4)", () => {
  it("still produces a reply, using safe defaults, with the failure recorded in reply_sent", async () => {
    deps.intentRouter = {
      async route(): Promise<RouterResult> {
        return { decision: SAFE_DEFAULT_DECISION, provider: null, model: null, certified: false, failureReason: "router call failed on both tiers: simulated" };
      }
    };

    const result = await sendMessage(deps, { userId: PRIMARY_USER_ID, text: "hello", recentTurns: [] });

    expect(result.replyText).toBe("Noted.");
    const payload = result.replyEvent.payload as ReplySentPayload;
    expect(payload.router.used).toBe(true);
    expect(payload.router.provider).toBeNull();
    expect(payload.router.certified).toBe(false);
    expect(payload.router.failureReason).toContain("failed on both tiers");
    expect(payload.contextProvenance.retrievalMode).toBe("hybrid");
  });
});

describe("sendMessage — EN-083 uncertified-tier gate bypass (verification item 5)", () => {
  it("a reply still arrives, and gateActions record nothing fired even though the router said fire=true", async () => {
    // Simulates the router itself already applying the EN-083 bypass
    // (intentRouter.ts's own responsibility, tested directly in
    // intentRouter.test.ts) — this test verifies chatPipeline.ts respects
    // whatever the router handed back, end to end.
    deps.intentRouter = fakeIntentRouter({
      decision: decisionWith(), // circleBack.fire=false, attestation.isAffirmation=false — already bypassed
      provider: "gemini",
      certified: false,
      failureReason: 'gates bypassed to no-action: decision served by uncertified tier "gemini" (EN-083)'
    });

    const result = await sendMessage(deps, { userId: PRIMARY_USER_ID, text: "hello", recentTurns: [] });

    expect(result.replyText).toBe("Noted.");
    const payload = result.replyEvent.payload as ReplySentPayload;
    expect(payload.gateActions).toEqual({ circleBackFired: null, attestationConfirmedEventId: null, selfBirthdateAskFired: false, selfFactAskFired: null, connectDotFired: false, elicitationFired: null });
    expect(payload.router.certified).toBe(false);
  });
});

describe("sendMessage — circle-back directive injection and EN-073 verification", () => {
  it("end-to-end: an eligible entity + router fire + reply that follows through -> recorded; reply that doesn't -> not recorded (R7)", async () => {
    givePrimaryUserSelfFactsKnown(projectionsDb); // isolates third-party circle-back from item 1/A's self-priority
    const marcusId = newId();
    const msg = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "My coworker Marcus helped me move.", attachmentOnly: false }, userId: PRIMARY_USER_ID });
    projectionsDb.insertEntity({
      id: marcusId,
      user_id: PRIMARY_USER_ID,
      name: "Marcus",
      confirmed: 0,
      source_event_ids: JSON.stringify([msg.id]),
      extractor_version: "message-v1",
      pending_disambiguation: null,
      created_at: new Date().toISOString()
    });

    // Case 1: the reply follows through.
    deps.chatRouter = fakeChatRouter("Noted. Who is Marcus, by the way?");
    deps.intentRouter = fakeIntentRouter({ decision: decisionWith({ curiosityTurn: { fire: true, kind: "thirdParty", entityId: marcusId, attribute: null, probeType: null } }) });
    const followedThrough = await sendMessage(deps, { userId: PRIMARY_USER_ID, text: "another update", recentTurns: [] });
    const followedPayload = followedThrough.replyEvent.payload as ReplySentPayload;
    expect(followedPayload.gateActions.circleBackFired).toMatchObject({ entityId: marcusId, name: "Marcus" });

    // Case 2: fresh store, router fires again, but the reply omits the ask (R7) -> not recorded.
    const eventLog2 = new EventLog(":memory:");
    const projections2 = new ProjectionsDb(":memory:");
    givePrimaryUserSelfFactsKnown(projections2);
    const msg2 = eventLog2.append({ type: "message_sent", actor: "user", payload: { text: "My coworker Marcus helped me move.", attachmentOnly: false }, userId: PRIMARY_USER_ID });
    projections2.insertEntity({
      id: marcusId,
      user_id: PRIMARY_USER_ID,
      name: "Marcus",
      confirmed: 0,
      source_event_ids: JSON.stringify([msg2.id]),
      extractor_version: "message-v1",
      pending_disambiguation: null,
      created_at: new Date().toISOString()
    });
    const deps2: SendMessageDeps = {
      eventLog: eventLog2,
      retrievalDb: new RetrievalDb(":memory:"),
      projectionsDb: projections2,
      embedder: fakeEmbedder,
      chatRouter: fakeChatRouter("That sounds like a nice gesture."), // never mentions Marcus
      intentRouter: fakeIntentRouter({ decision: decisionWith({ curiosityTurn: { fire: true, kind: "thirdParty", entityId: marcusId, attribute: null, probeType: null } }) })
    };
    const omitted = await sendMessage(deps2, { userId: PRIMARY_USER_ID, text: "another update", recentTurns: [] });
    const omittedPayload = omitted.replyEvent.payload as ReplySentPayload;
    expect(omittedPayload.gateActions.circleBackFired).toBeNull();
  });

  it("item 1: self-birthdate establishment OUTRANKS an otherwise-eligible third-party circle-back — third party never fires while the birthdate is unknown", async () => {
    const marcusId = newId();
    const msg = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "My coworker Marcus helped me move.", attachmentOnly: false }, userId: PRIMARY_USER_ID });
    projectionsDb.insertEntity({
      id: marcusId,
      user_id: PRIMARY_USER_ID,
      name: "Marcus",
      confirmed: 0,
      source_event_ids: JSON.stringify([msg.id]),
      extractor_version: "message-v1",
      pending_disambiguation: null,
      created_at: new Date().toISOString()
    });
    // No birthdate given this time — the router would happily fire on Marcus...
    deps.chatRouter = fakeChatRouter("Got it. When's your birthday, by the way?"); // ...but the self-directive should win, not the third-party one
    deps.intentRouter = fakeIntentRouter({ decision: decisionWith({ curiosityTurn: { fire: true, kind: "thirdParty", entityId: marcusId, attribute: null, probeType: null } }) });

    const result = await sendMessage(deps, { userId: PRIMARY_USER_ID, text: "another update", recentTurns: [] });

    const payload = result.replyEvent.payload as ReplySentPayload;
    expect(payload.gateActions.circleBackFired).toBeNull(); // Marcus never got the slot
    expect(payload.gateActions.selfBirthdateAskFired).toBe(true);
  });

  it("EN-097 ordering: self-birthdate establishment ALSO outranks elicitation on a genuinely fresh, first-real-turn user — the two never collide", async () => {
    // A brand-new user (empty archive) is exactly the scenario where BOTH
    // selfBirthdateGate and elicitation's Layer 1 would otherwise want the
    // first move — this is the explicit ordering resolution from
    // proactiveOpener.ts's own doc comment, verified end to end here.
    deps.chatRouter = fakeChatRouter("Great to meet you, Richard. When's your birthday?"); // the self-directive should win, not the elicitation one
    deps.intentRouter = fakeIntentRouter({ decision: decisionWith({ curiosityTurn: { fire: true, kind: "elicitation", entityId: null, attribute: null, probeType: "call2am" } }) });

    const result = await sendMessage(deps, { userId: PRIMARY_USER_ID, text: "Richard", recentTurns: [] });

    const payload = result.replyEvent.payload as ReplySentPayload;
    expect(payload.gateActions.elicitationFired).toBeNull(); // elicitation never got the slot
    expect(payload.gateActions.selfBirthdateAskFired).toBe(true);
  });
});

describe("sendMessage — attestation gate resolves to a real fact_confirmed event", () => {
  it("emits fact_confirmed bound to the extraction event ULID (EN-055) when the router validates an affirmation", async () => {
    const elenaId = newId();
    const msg = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "Elena lives in Seattle.", attachmentOnly: false }, userId: PRIMARY_USER_ID });
    const extraction = eventLog.append({
      type: "extraction_completed",
      actor: "system",
      payload: { sourceEventId: msg.id, extractorVersion: "message-v1", entities: [], structuralAtoms: [], socialBonds: [], attributes: [{ entityName: "Elena", attribute: "location", value: "Seattle", eventDate: null }] },
      userId: PRIMARY_USER_ID
    });
    projectionsDb.insertEntity({
      id: elenaId,
      user_id: PRIMARY_USER_ID,
      name: "Elena",
      confirmed: 0,
      source_event_ids: JSON.stringify([msg.id, extraction.id]),
      extractor_version: "message-v1",
      pending_disambiguation: null,
      created_at: new Date().toISOString()
    });
    projectionsDb.insertEntityAttribute({
      id: newId(),
      user_id: PRIMARY_USER_ID,
      entity_id: elenaId,
      attribute: "location",
      value: "Seattle",
      source_event_ids: JSON.stringify([msg.id, extraction.id]),
      created_at: new Date().toISOString()
    });

    deps.intentRouter = fakeIntentRouter({ decision: decisionWith({ attestation: { isAffirmation: true, entityName: "Elena", attribute: "location", value: "Seattle" } }) });

    const result = await sendMessage(deps, { userId: PRIMARY_USER_ID, text: "yes, that's right", recentTurns: [] });

    expect(result.factConfirmedEvent).toBeDefined();
    expect(result.factConfirmedEvent!.type).toBe("fact_confirmed");
    expect(result.factConfirmedEvent!.payload).toEqual({ targetEventId: extraction.id, entityName: "Elena", attribute: "location", value: "Seattle" });
    const payload = result.replyEvent.payload as ReplySentPayload;
    expect(payload.gateActions.attestationConfirmedEventId).toBe(result.factConfirmedEvent!.id);
  });
});

describe("sendMessage — retrieval mode from a validated router decision", () => {
  it("uses entity mode with temporalWeight/n passed through when the router decides it", async () => {
    deps.intentRouter = fakeIntentRouter({ decision: decisionWith({ retrieval: { mode: "recency", entityId: null, temporalWeight: 0, n: 3 } }) });

    const result = await sendMessage(deps, { userId: PRIMARY_USER_ID, text: "catch me up", recentTurns: [] });

    expect(result.debug.retrieval.mode).toBe("recency");
  });
});

describe("sendMessage — EN-047/048 voice mode wiring", () => {
  function chatRouterCapturingSystem() {
    let capturedSystem = "";
    const router: ChatRouter = {
      async reply(request) {
        capturedSystem = request.system;
        return CANNED_REPLY;
      }
    };
    return { router, getCapturedSystem: () => capturedSystem };
  }

  it("NEGATIVE CASE: ordinary conversation, no router configured, gets the natural voice — zen never injects by default", async () => {
    const { router, getCapturedSystem } = chatRouterCapturingSystem();
    deps.chatRouter = router;
    // No deps.intentRouter set — Part-1 fallback path.

    const result = await sendMessage(deps, { userId: PRIMARY_USER_ID, text: "just a regular update about my day", recentTurns: [] });

    const system = getCapturedSystem();
    expect(system).toMatch(/THE NATURAL VOICE/);
    expect(system).not.toMatch(/ZEN MODE —/);
    const payload = result.replyEvent.payload as ReplySentPayload;
    expect(payload.voiceMode).toEqual({ mode: "natural", triggeredByPhrase: false });
  });

  it("NEGATIVE CASE: ordinary conversation with a real (fake) router that itself decides natural", async () => {
    const { router, getCapturedSystem } = chatRouterCapturingSystem();
    deps.chatRouter = router;
    deps.intentRouter = fakeIntentRouter({ decision: decisionWith({ register: { mode: "natural" } }) });

    const result = await sendMessage(deps, { userId: PRIMARY_USER_ID, text: "just a regular update about my day", recentTurns: [] });

    const system = getCapturedSystem();
    expect(system).toMatch(/THE NATURAL VOICE/);
    expect(system).not.toMatch(/ZEN MODE —/);
    const payload = result.replyEvent.payload as ReplySentPayload;
    expect(payload.voiceMode).toEqual({ mode: "natural", triggeredByPhrase: false });
  });

  it("a literal trigger phrase in the message injects zen mode even with no router configured", async () => {
    const { router, getCapturedSystem } = chatRouterCapturingSystem();
    deps.chatRouter = router;

    const result = await sendMessage(deps, { userId: PRIMARY_USER_ID, text: "I need to step back from all of this", recentTurns: [] });

    const system = getCapturedSystem();
    expect(system).toMatch(/ZEN MODE —/);
    expect(system).not.toMatch(/THE NATURAL VOICE/);
    const payload = result.replyEvent.payload as ReplySentPayload;
    expect(payload.voiceMode).toEqual({ mode: "zen", triggeredByPhrase: true });
  });

  it("the router's own register judgment injects zen mode even with no literal trigger phrase present", async () => {
    const { router, getCapturedSystem } = chatRouterCapturingSystem();
    deps.chatRouter = router;
    deps.intentRouter = fakeIntentRouter({ decision: decisionWith({ register: { mode: "zen" } }) });

    const result = await sendMessage(deps, { userId: PRIMARY_USER_ID, text: "I don't even know where to start, everything is falling apart at once", recentTurns: [] });

    const system = getCapturedSystem();
    expect(system).toMatch(/ZEN MODE —/);
    const payload = result.replyEvent.payload as ReplySentPayload;
    expect(payload.voiceMode).toEqual({ mode: "zen", triggeredByPhrase: false });
  });

  it("a literal trigger phrase wins even when the router itself says natural", async () => {
    const { router, getCapturedSystem } = chatRouterCapturingSystem();
    deps.chatRouter = router;
    deps.intentRouter = fakeIntentRouter({ decision: decisionWith({ register: { mode: "natural" } }) });

    const result = await sendMessage(deps, { userId: PRIMARY_USER_ID, text: "can we zoom out for a second", recentTurns: [] });

    const system = getCapturedSystem();
    expect(system).toMatch(/ZEN MODE —/);
    const payload = result.replyEvent.payload as ReplySentPayload;
    expect(payload.voiceMode).toEqual({ mode: "zen", triggeredByPhrase: true });
  });
});
