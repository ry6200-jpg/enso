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
  circleBackCandidates: [{ entityId: "c1", name: "Marcus" }],
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

  it("suppresses circleBack.fire when the model invents an entityId not in circleBackCandidates", async () => {
    const primary = vi.fn<RouterAdapter>(async () => fakeResult("openai", decisionWith({ circleBack: { fire: true, entityId: "not-a-candidate" } })));
    const router = createIntentRouter(primary, primary);

    const result = await router.route(BASE_REQUEST);

    expect(result.decision.circleBack).toEqual({ fire: false, entityId: null });
  });

  it("keeps circleBack.fire when the entityId IS in circleBackCandidates", async () => {
    const primary = vi.fn<RouterAdapter>(async () => fakeResult("openai", decisionWith({ circleBack: { fire: true, entityId: "c1" } })));
    const router = createIntentRouter(primary, primary);

    const result = await router.route(BASE_REQUEST);

    expect(result.decision.circleBack).toEqual({ fire: true, entityId: "c1" });
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
  it("forces circleBack and attestation to no-action when the decision was served by an uncertified provider, even though it validated cleanly", async () => {
    const primary = vi.fn<RouterAdapter>(async () => {
      throw new ProviderAvailabilityError("503", 503);
    });
    const fallback = vi.fn<RouterAdapter>(async () =>
      fakeResult("gemini", decisionWith({ circleBack: { fire: true, entityId: "c1" }, attestation: { isAffirmation: true, entityName: "Elena", attribute: "location", value: "Seattle" } }))
    );
    const router = createIntentRouter(primary, fallback, new Set(["openai"]));

    const result = await router.route(BASE_REQUEST);

    expect(result.provider).toBe("gemini");
    expect(result.decision.circleBack).toEqual({ fire: false, entityId: null });
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
});
