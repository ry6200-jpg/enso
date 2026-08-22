import { describe, expect, it, vi } from "vitest";
import { createIntentRouter } from "../src/conversation/router/intentRouter.js";
import { SAFE_DEFAULT_DECISION, type RouterCallResult, type RouterDecision, type RouterRequest } from "../src/conversation/router/routerTypes.js";
import type { RouterAdapter } from "../src/conversation/router/routerAdapters.js";
import { ClientRequestError, ProviderAvailabilityError } from "../src/providers/errors.js";
import { CostTracker } from "../src/providers/costTracker.js";

const BASE_REQUEST: RouterRequest = {
  message: "hello",
  recentTurns: [],
  knownEntities: [{ entityId: "e1", name: "Elena" }],
  curiosityTurnEligible: true,
  curiosityCandidates: [{ kind: "thirdParty", candidate: { entityId: "c1", name: "Marcus", attemptNumber: 1, mentionAgeLabel: "earlier today", stableKey: "stable-c1" } }],
  recentAttributeClaims: [{ entityName: "Elena", attribute: "location", value: "Seattle", extractionEventId: "ext1" }]
};

function fakeResult(provider: "openai" | "gemini", decision: RouterDecision): RouterCallResult {
  return { provider, model: provider === "openai" ? "gpt-5.6-terra" : "gemini-3.7-flash", decision, usage: { inputTokens: 10, outputTokens: 5 } };
}

function decisionWith(overrides: Partial<RouterDecision> = {}): RouterDecision {
  return structuredClone({ ...SAFE_DEFAULT_DECISION, ...overrides });
}

describe("createIntentRouter — fail-safe (EN-075)", () => {
  it("returns SAFE_DEFAULT_DECISION, never throws, when both tiers fail", async () => {
    const primary = vi.fn<RouterAdapter>(async () => {
      throw new ProviderAvailabilityError("503", 503);
    });
    const fallback = vi.fn<RouterAdapter>(async () => {
      throw new ProviderAvailabilityError("503", 503);
    });
    const router = createIntentRouter(primary, fallback);

    const result = await router.route(BASE_REQUEST);

    expect(result.decision).toEqual(SAFE_DEFAULT_DECISION);
    expect(result.provider).toBeNull();
    expect(result.certified).toBe(false);
    expect(result.failureReason).toBeTruthy();
  });

  it("falls back to tier 2 on a 5xx primary failure, same as chat/extraction routers", async () => {
    const primary = vi.fn<RouterAdapter>(async () => {
      throw new ProviderAvailabilityError("503", 503);
    });
    const fallback = vi.fn<RouterAdapter>(async () => fakeResult("gemini", decisionWith()));
    const router = createIntentRouter(primary, fallback);

    const result = await router.route(BASE_REQUEST);

    expect(result.provider).toBe("gemini");
  });

  it("does not fall back on a 4xx client error (EN-083)", async () => {
    const primary = vi.fn<RouterAdapter>(async () => {
      throw new ClientRequestError("bad request", 400);
    });
    const fallback = vi.fn<RouterAdapter>(async () => fakeResult("gemini", decisionWith()));
    const router = createIntentRouter(primary, fallback);

    const result = await router.route(BASE_REQUEST);

    // ClientRequestError is not caught by intentRouter's outer try/catch's
    // "both tiers failed" path — runWithFallback re-throws it immediately,
    // same as chat/extraction. The router's own fail-safe still applies:
    // never throw out of route().
    expect(fallback).not.toHaveBeenCalled();
    expect(result.decision).toEqual(SAFE_DEFAULT_DECISION);
    expect(result.failureReason).toContain("malformed client request");
  });

  it("records cost for whichever tier actually served the decision", async () => {
    const primary = vi.fn<RouterAdapter>(async () => fakeResult("openai", decisionWith()));
    const fallback = vi.fn<RouterAdapter>(async () => fakeResult("gemini", decisionWith()));
    const costTracker = new CostTracker();
    const router = createIntentRouter(primary, fallback, new Set(["openai"]), costTracker);

    await router.route(BASE_REQUEST);

    expect(costTracker.all()).toHaveLength(1);
    expect(costTracker.all()[0]!.provider).toBe("openai");
  });
});

describe("createIntentRouter — per-axis validation against candidate lists", () => {
  it("degrades entity-mode retrieval to hybrid when the model invents an entityId not in knownEntities", async () => {
    const primary = vi.fn<RouterAdapter>(async () => fakeResult("openai", decisionWith({ retrieval: { mode: "entity", entityId: "not-a-real-id", temporalWeight: 0, n: null } })));
    const router = createIntentRouter(primary, primary);

    const result = await router.route(BASE_REQUEST);

    expect(result.decision.retrieval).toEqual({ mode: "hybrid", entityId: null, temporalWeight: 0, n: null });
    expect(result.failureReason).toContain("not a known entity");
  });

  it("keeps entity-mode retrieval when the entityId IS in knownEntities", async () => {
    const primary = vi.fn<RouterAdapter>(async () => fakeResult("openai", decisionWith({ retrieval: { mode: "entity", entityId: "e1", temporalWeight: 0, n: null } })));
    const router = createIntentRouter(primary, primary);

    const result = await router.route(BASE_REQUEST);

    expect(result.decision.retrieval.mode).toBe("entity");
    expect(result.decision.retrieval.entityId).toBe("e1");
    expect(result.certified).toBe(true);
  });

  it("suppresses curiosityTurn.fire when the model invents an entityId not in curiosityCandidates", async () => {
    const primary = vi.fn<RouterAdapter>(async () => fakeResult("openai", decisionWith({ curiosityTurn: { fire: true, kind: "thirdParty", entityId: "not-a-candidate", attribute: null } })));
    const router = createIntentRouter(primary, primary);

    const result = await router.route(BASE_REQUEST);

    expect(result.decision.curiosityTurn).toEqual({ fire: false, kind: null, entityId: null, attribute: null });
  });

  it("keeps curiosityTurn.fire when the entityId IS in curiosityCandidates", async () => {
    const primary = vi.fn<RouterAdapter>(async () => fakeResult("openai", decisionWith({ curiosityTurn: { fire: true, kind: "thirdParty", entityId: "c1", attribute: null } })));
    const router = createIntentRouter(primary, primary);

    const result = await router.route(BASE_REQUEST);

    expect(result.decision.curiosityTurn).toEqual({ fire: true, kind: "thirdParty", entityId: "c1", attribute: null });
  });

  it("suppresses curiosityTurn.fire outright when curiosityTurnEligible was false, regardless of a valid candidate", async () => {
    const primary = vi.fn<RouterAdapter>(async () => fakeResult("openai", decisionWith({ curiosityTurn: { fire: true, kind: "thirdParty", entityId: "c1", attribute: null } })));
    const router = createIntentRouter(primary, primary);

    const result = await router.route({ ...BASE_REQUEST, curiosityTurnEligible: false });

    expect(result.decision.curiosityTurn).toEqual({ fire: false, kind: null, entityId: null, attribute: null });
    expect(result.failureReason).toContain("condition B");
  });

  it("suppresses curiosityTurn.fire when the model invents an attribute not in the selfFact candidates", async () => {
    const primary = vi.fn<RouterAdapter>(async () => fakeResult("openai", decisionWith({ curiosityTurn: { fire: true, kind: "selfFact", entityId: null, attribute: "occupation" } })));
    const router = createIntentRouter(primary, primary);

    const result = await router.route(BASE_REQUEST); // BASE_REQUEST's only candidate is thirdParty, not selfFact

    expect(result.decision.curiosityTurn).toEqual({ fire: false, kind: null, entityId: null, attribute: null });
  });

  it("keeps curiosityTurn.fire for a selfFact attribute that IS in the candidates", async () => {
    const request: RouterRequest = { ...BASE_REQUEST, curiosityCandidates: [{ kind: "selfFact", attribute: "occupation" }] };
    const primary = vi.fn<RouterAdapter>(async () => fakeResult("openai", decisionWith({ curiosityTurn: { fire: true, kind: "selfFact", entityId: null, attribute: "occupation" } })));
    const router = createIntentRouter(primary, primary);

    const result = await router.route(request);

    expect(result.decision.curiosityTurn).toEqual({ fire: true, kind: "selfFact", entityId: null, attribute: "occupation" });
  });

  it("keeps curiosityTurn.fire for kind=connectDot with no candidate list needed, same as register", async () => {
    const primary = vi.fn<RouterAdapter>(async () => fakeResult("openai", decisionWith({ curiosityTurn: { fire: true, kind: "connectDot", entityId: null, attribute: null } })));
    const router = createIntentRouter(primary, primary);

    const result = await router.route(BASE_REQUEST);

    expect(result.decision.curiosityTurn).toEqual({ fire: true, kind: "connectDot", entityId: null, attribute: null });
  });

  it("suppresses attestation when the (entityName, attribute, value) triple doesn't exactly match a recent claim", async () => {
    const primary = vi.fn<RouterAdapter>(async () =>
      fakeResult("openai", decisionWith({ attestation: { isAffirmation: true, entityName: "Elena", attribute: "location", value: "Portland" } }))
    );
    const router = createIntentRouter(primary, primary);

    const result = await router.route(BASE_REQUEST);

    expect(result.decision.attestation.isAffirmation).toBe(false);
  });

  it("keeps attestation when it exactly matches a recent claim", async () => {
    const primary = vi.fn<RouterAdapter>(async () =>
      fakeResult("openai", decisionWith({ attestation: { isAffirmation: true, entityName: "Elena", attribute: "location", value: "Seattle" } }))
    );
    const router = createIntentRouter(primary, primary);

    const result = await router.route(BASE_REQUEST);

    expect(result.decision.attestation).toEqual({ isAffirmation: true, entityName: "Elena", attribute: "location", value: "Seattle" });
  });
});

describe("createIntentRouter — EN-083 uncertified-tier gate bypass", () => {
  it("forces curiosityTurn and attestation to no-action when the decision was served by an uncertified provider, even though it validated cleanly", async () => {
    const primary = vi.fn<RouterAdapter>(async () => {
      throw new ProviderAvailabilityError("503", 503);
    });
    const fallback = vi.fn<RouterAdapter>(async () =>
      fakeResult("gemini", decisionWith({ curiosityTurn: { fire: true, kind: "thirdParty", entityId: "c1", attribute: null }, attestation: { isAffirmation: true, entityName: "Elena", attribute: "location", value: "Seattle" } }))
    );
    const router = createIntentRouter(primary, fallback, new Set(["openai"]));

    const result = await router.route(BASE_REQUEST);

    expect(result.provider).toBe("gemini");
    expect(result.decision.curiosityTurn).toEqual({ fire: false, kind: null, entityId: null, attribute: null });
    expect(result.decision.attestation.isAffirmation).toBe(false);
    expect(result.certified).toBe(false);
    expect(result.failureReason).toContain("uncertified tier");
  });

  it("still uses retrieval mode from an uncertified tier's decision — retrieval degrades quality, never fabricates an authoritative event", async () => {
    const primary = vi.fn<RouterAdapter>(async () => {
      throw new ProviderAvailabilityError("503", 503);
    });
    const fallback = vi.fn<RouterAdapter>(async () => fakeResult("gemini", decisionWith({ retrieval: { mode: "recency", entityId: null, temporalWeight: 0, n: 7 } })));
    const router = createIntentRouter(primary, fallback, new Set(["openai"]));

    const result = await router.route(BASE_REQUEST);

    expect(result.decision.retrieval).toEqual({ mode: "recency", entityId: null, temporalWeight: 0, n: 7 });
  });

  it("a decision from the certified tier with no violations is marked certified with no failureReason", async () => {
    const primary = vi.fn<RouterAdapter>(async () => fakeResult("openai", decisionWith()));
    const router = createIntentRouter(primary, primary, new Set(["openai"]));

    const result = await router.route(BASE_REQUEST);

    expect(result.certified).toBe(true);
    expect(result.failureReason).toBeNull();
  });

  it("EN-048: forces register.mode from zen back to natural when served by an uncertified provider, same no-action treatment as curiosityTurn/attestation", async () => {
    const primary = vi.fn<RouterAdapter>(async () => {
      throw new ProviderAvailabilityError("503", 503);
    });
    const fallback = vi.fn<RouterAdapter>(async () => fakeResult("gemini", decisionWith({ register: { mode: "zen" } })));
    const router = createIntentRouter(primary, fallback, new Set(["openai"]));

    const result = await router.route(BASE_REQUEST);

    expect(result.decision.register).toEqual({ mode: "natural" });
    expect(result.certified).toBe(false);
    expect(result.failureReason).toContain("uncertified tier");
  });

  it("keeps register.mode zen when served by the certified tier", async () => {
    const primary = vi.fn<RouterAdapter>(async () => fakeResult("openai", decisionWith({ register: { mode: "zen" } })));
    const router = createIntentRouter(primary, primary, new Set(["openai"]));

    const result = await router.route(BASE_REQUEST);

    expect(result.decision.register).toEqual({ mode: "zen" });
    expect(result.certified).toBe(true);
  });
});

describe("SAFE_DEFAULT_DECISION (EN-048)", () => {
  it("defaults register to natural, never zen", () => {
    expect(SAFE_DEFAULT_DECISION.register).toEqual({ mode: "natural" });
  });
});
