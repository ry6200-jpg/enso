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
  recentAttributeClaims: [{ entityName: "Elena", attribute: "location", value: "Seattle", extractionEventId: "ext1" }],
  ambientLocationCandidates: [{ entityId: "e1", name: "Elena", location: "Seattle" }],
  ownLocationAvailable: true,
  primaryResidenceKnown: true,
  coReferencePendingCandidates: [],
  coReferenceConfirmedPairings: [],
  coReferenceAskCandidates: [],
  mergePendingProposal: null,
  typoMergeAskCandidates: [],
  typoMergePendingCandidates: []
};

function fakeResult(provider: "openai" | "gemini", decision: RouterDecision): RouterCallResult {
  return { provider, model: provider === "openai" ? "gpt-5.6-terra" : "gemini-3.7-flash", decision, usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 } };
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
    const primary = vi.fn<RouterAdapter>(async () => fakeResult("openai", decisionWith({ curiosityTurn: { fire: true, kind: "thirdParty", entityId: "not-a-candidate", attribute: null, probeType: null } })));
    const router = createIntentRouter(primary, primary);

    const result = await router.route(BASE_REQUEST);

    expect(result.decision.curiosityTurn).toEqual({ fire: false, kind: null, entityId: null, attribute: null, probeType: null });
  });

  it("keeps curiosityTurn.fire when the entityId IS in curiosityCandidates", async () => {
    const primary = vi.fn<RouterAdapter>(async () => fakeResult("openai", decisionWith({ curiosityTurn: { fire: true, kind: "thirdParty", entityId: "c1", attribute: null, probeType: null } })));
    const router = createIntentRouter(primary, primary);

    const result = await router.route(BASE_REQUEST);

    expect(result.decision.curiosityTurn).toEqual({ fire: true, kind: "thirdParty", entityId: "c1", attribute: null, probeType: null });
  });

  it("suppresses curiosityTurn.fire outright when curiosityTurnEligible was false, regardless of a valid candidate", async () => {
    const primary = vi.fn<RouterAdapter>(async () => fakeResult("openai", decisionWith({ curiosityTurn: { fire: true, kind: "thirdParty", entityId: "c1", attribute: null, probeType: null } })));
    const router = createIntentRouter(primary, primary);

    const result = await router.route({ ...BASE_REQUEST, curiosityTurnEligible: false });

    expect(result.decision.curiosityTurn).toEqual({ fire: false, kind: null, entityId: null, attribute: null, probeType: null });
    expect(result.failureReason).toContain("condition B");
  });

  it("suppresses curiosityTurn.fire when the model invents an attribute not in the selfFact candidates", async () => {
    const primary = vi.fn<RouterAdapter>(async () => fakeResult("openai", decisionWith({ curiosityTurn: { fire: true, kind: "selfFact", entityId: null, attribute: "occupation", probeType: null } })));
    const router = createIntentRouter(primary, primary);

    const result = await router.route(BASE_REQUEST); // BASE_REQUEST's only candidate is thirdParty, not selfFact

    expect(result.decision.curiosityTurn).toEqual({ fire: false, kind: null, entityId: null, attribute: null, probeType: null });
  });

  it("keeps curiosityTurn.fire for a selfFact attribute that IS in the candidates", async () => {
    const request: RouterRequest = { ...BASE_REQUEST, curiosityCandidates: [{ kind: "selfFact", attribute: "occupation" }] };
    const primary = vi.fn<RouterAdapter>(async () => fakeResult("openai", decisionWith({ curiosityTurn: { fire: true, kind: "selfFact", entityId: null, attribute: "occupation", probeType: null } })));
    const router = createIntentRouter(primary, primary);

    const result = await router.route(request);

    expect(result.decision.curiosityTurn).toEqual({ fire: true, kind: "selfFact", entityId: null, attribute: "occupation", probeType: null });
  });

  it("keeps curiosityTurn.fire for kind=connectDot with no candidate list needed, same as register", async () => {
    const primary = vi.fn<RouterAdapter>(async () => fakeResult("openai", decisionWith({ curiosityTurn: { fire: true, kind: "connectDot", entityId: null, attribute: null, probeType: null } })));
    const router = createIntentRouter(primary, primary);

    const result = await router.route(BASE_REQUEST);

    expect(result.decision.curiosityTurn).toEqual({ fire: true, kind: "connectDot", entityId: null, attribute: null, probeType: null });
  });

  it("suppresses coReference.fire (direction=ask) when the model invents a pendingStableKey not in coReferenceAskCandidates", async () => {
    const primary = vi.fn<RouterAdapter>(async () => fakeResult("openai", decisionWith({ coReference: { fire: true, direction: "ask", pendingStableKey: "not-a-candidate" } })));
    const router = createIntentRouter(primary, primary);

    const result = await router.route(BASE_REQUEST); // BASE_REQUEST.coReferenceAskCandidates is []

    expect(result.decision.coReference).toEqual({ fire: false, direction: null, pendingStableKey: null });
    expect(result.failureReason).toContain("not an eligible ask candidate");
  });

  it("keeps coReference.fire (direction=ask) when the pendingStableKey IS in coReferenceAskCandidates", async () => {
    const request: RouterRequest = {
      ...BASE_REQUEST,
      coReferenceAskCandidates: [
        {
          kind: "coReference",
          placeholderEntityId: "p1",
          placeholderName: "father",
          placeholderStableKey: "stable-p1",
          realEntityId: "r1",
          realName: "An Song",
          realStableKey: "stable-r1",
          anchorEntityId: "a1",
          anchorName: "Vanessa",
          relationType: "parent_of",
          attemptNumber: 1
        }
      ]
    };
    const primary = vi.fn<RouterAdapter>(async () => fakeResult("openai", decisionWith({ coReference: { fire: true, direction: "ask", pendingStableKey: "stable-p1" } })));
    const router = createIntentRouter(primary, primary);

    const result = await router.route(request);

    expect(result.decision.coReference).toEqual({ fire: true, direction: "ask", pendingStableKey: "stable-p1" });
  });

  it("owner-initiated merge: keeps mergeRequest as reported — free-text name spans, no candidate list to validate against", async () => {
    const primary = vi.fn<RouterAdapter>(async () =>
      fakeResult("openai", decisionWith({ mergeRequest: { fire: true, firstName: "Ah Song", secondName: "An Song", survivingName: "An Song" } }))
    );
    const router = createIntentRouter(primary, primary);

    const result = await router.route(BASE_REQUEST);

    expect(result.decision.mergeRequest).toEqual({ fire: true, firstName: "Ah Song", secondName: "An Song", survivingName: "An Song" });
  });

  it("owner-initiated merge: suppresses mergeRequest.fire when the model omits firstName or secondName", async () => {
    const primary = vi.fn<RouterAdapter>(async () => fakeResult("openai", decisionWith({ mergeRequest: { fire: true, firstName: "Ah Song", secondName: null, survivingName: null } })));
    const router = createIntentRouter(primary, primary);

    const result = await router.route(BASE_REQUEST);

    expect(result.decision.mergeRequest).toEqual({ fire: false, firstName: null, secondName: null, survivingName: null });
    expect(result.failureReason).toContain("firstName/secondName missing");
  });

  it("owner-initiated merge: suppresses a sub-field left set while fire=false", async () => {
    const primary = vi.fn<RouterAdapter>(async () => fakeResult("openai", decisionWith({ mergeRequest: { fire: false, firstName: "Ah Song", secondName: null, survivingName: null } })));
    const router = createIntentRouter(primary, primary);

    const result = await router.route(BASE_REQUEST);

    expect(result.decision.mergeRequest).toEqual({ fire: false, firstName: null, secondName: null, survivingName: null });
  });

  it("typo-merge: keeps direction=\"ask\" when the pairKey is eligible AND one of the two names is live in the current message", async () => {
    const request = {
      ...BASE_REQUEST,
      message: "An Song came by again today.",
      typoMergeAskCandidates: [{ kind: "typoMerge" as const, pairKey: "01A|01B", firstStableKey: "01A", firstName: "An Song", secondStableKey: "01B", secondName: "Ah Song", proposedSurvivorName: "An Song", attemptNumber: 1 as const }]
    };
    const primary = vi.fn<RouterAdapter>(async () => fakeResult("openai", decisionWith({ typoMerge: { fire: true, direction: "ask", pendingStableKey: "01A|01B", survivingName: null } })));
    const router = createIntentRouter(primary, primary);

    const result = await router.route(request);

    expect(result.decision.typoMerge).toEqual({ fire: true, direction: "ask", pendingStableKey: "01A|01B", survivingName: null });
  });

  it("typo-merge: the gate holds — suppresses direction=\"ask\" when NEITHER name is live in the current message, even though the pairKey is a real candidate", async () => {
    const request = {
      ...BASE_REQUEST,
      message: "Just an ordinary update, nothing about anyone in particular.",
      typoMergeAskCandidates: [{ kind: "typoMerge" as const, pairKey: "01A|01B", firstStableKey: "01A", firstName: "An Song", secondStableKey: "01B", secondName: "Ah Song", proposedSurvivorName: "An Song", attemptNumber: 1 as const }]
    };
    const primary = vi.fn<RouterAdapter>(async () => fakeResult("openai", decisionWith({ typoMerge: { fire: true, direction: "ask", pendingStableKey: "01A|01B", survivingName: null } })));
    const router = createIntentRouter(primary, primary);

    const result = await router.route(request);

    expect(result.decision.typoMerge).toEqual({ fire: false, direction: null, pendingStableKey: null, survivingName: null });
    expect(result.failureReason).toContain("neither name is live");
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

  it("ambient context batch, item 1: suppresses thirdPartyEntityId when the model invents one not in ambientLocationCandidates", async () => {
    const primary = vi.fn<RouterAdapter>(async () =>
      fakeResult("openai", decisionWith({ ambientContext: { relevant: true, ownSituation: false, thirdPartyEntityId: "not-a-candidate", namedPlaceForDistance: null } }))
    );
    const router = createIntentRouter(primary, primary);

    const result = await router.route(BASE_REQUEST);

    expect(result.decision.ambientContext).toEqual({ relevant: false, ownSituation: false, thirdPartyEntityId: null, namedPlaceForDistance: null });
  });

  it("keeps thirdPartyEntityId when it IS in ambientLocationCandidates", async () => {
    const primary = vi.fn<RouterAdapter>(async () =>
      fakeResult("openai", decisionWith({ ambientContext: { relevant: true, ownSituation: false, thirdPartyEntityId: "e1", namedPlaceForDistance: null } }))
    );
    const router = createIntentRouter(primary, primary);

    const result = await router.route(BASE_REQUEST);

    expect(result.decision.ambientContext).toEqual({ relevant: true, ownSituation: false, thirdPartyEntityId: "e1", namedPlaceForDistance: null });
  });

  it("suppresses ownSituation when ownLocationAvailable was false this turn, regardless of the model's own judgment", async () => {
    const primary = vi.fn<RouterAdapter>(async () =>
      fakeResult("openai", decisionWith({ ambientContext: { relevant: true, ownSituation: true, thirdPartyEntityId: null, namedPlaceForDistance: null } }))
    );
    const router = createIntentRouter(primary, primary);

    const result = await router.route({ ...BASE_REQUEST, ownLocationAvailable: false });

    expect(result.decision.ambientContext).toEqual({ relevant: false, ownSituation: false, thirdPartyEntityId: null, namedPlaceForDistance: null });
  });

  it("keeps ownSituation when ownLocationAvailable was true", async () => {
    const primary = vi.fn<RouterAdapter>(async () =>
      fakeResult("openai", decisionWith({ ambientContext: { relevant: true, ownSituation: true, thirdPartyEntityId: null, namedPlaceForDistance: null } }))
    );
    const router = createIntentRouter(primary, primary);

    const result = await router.route(BASE_REQUEST); // ownLocationAvailable: true

    expect(result.decision.ambientContext.ownSituation).toBe(true);
  });

  it("keeps namedPlaceForDistance as free text — never validated against a candidate list, unlike entity ids", async () => {
    const primary = vi.fn<RouterAdapter>(async () =>
      fakeResult("openai", decisionWith({ ambientContext: { relevant: true, ownSituation: false, thirdPartyEntityId: null, namedPlaceForDistance: "the pharmacy she mentioned" } }))
    );
    const router = createIntentRouter(primary, primary);

    const result = await router.route(BASE_REQUEST);

    expect(result.decision.ambientContext.namedPlaceForDistance).toBe("the pharmacy she mentioned");
  });

  it("suppresses ambientContext entirely when relevant=false but a sub-field was set anyway — a malformed-but-schema-valid decision", async () => {
    const primary = vi.fn<RouterAdapter>(async () =>
      fakeResult("openai", decisionWith({ ambientContext: { relevant: false, ownSituation: true, thirdPartyEntityId: null, namedPlaceForDistance: "somewhere" } }))
    );
    const router = createIntentRouter(primary, primary);

    const result = await router.route(BASE_REQUEST);

    expect(result.decision.ambientContext).toEqual({ relevant: false, ownSituation: false, thirdPartyEntityId: null, namedPlaceForDistance: null });
  });

  it("downgrades relevant=true to false when every sub-field ends up cleared after validation — nothing left to fetch", async () => {
    const primary = vi.fn<RouterAdapter>(async () =>
      fakeResult("openai", decisionWith({ ambientContext: { relevant: true, ownSituation: true, thirdPartyEntityId: null, namedPlaceForDistance: null } }))
    );
    const router = createIntentRouter(primary, primary);

    // ownLocationAvailable false clears the only true field (ownSituation), leaving nothing relevant.
    const result = await router.route({ ...BASE_REQUEST, ownLocationAvailable: false });

    expect(result.decision.ambientContext.relevant).toBe(false);
  });

  it("part 4: keeps travelContext.relevant with a destinationHint as free text — never validated against a candidate list", async () => {
    const primary = vi.fn<RouterAdapter>(async () => fakeResult("openai", decisionWith({ travelContext: { relevant: true, destinationHint: "my mom's place" } })));
    const router = createIntentRouter(primary, primary);

    const result = await router.route(BASE_REQUEST);

    expect(result.decision.travelContext).toEqual({ relevant: true, destinationHint: "my mom's place" });
  });

  it("part 4: keeps travelContext.relevant with destinationHint null — a valid state, the fetch layer falls back to the owner's own residence", async () => {
    const primary = vi.fn<RouterAdapter>(async () => fakeResult("openai", decisionWith({ travelContext: { relevant: true, destinationHint: null } })));
    const router = createIntentRouter(primary, primary);

    const result = await router.route(BASE_REQUEST);

    expect(result.decision.travelContext).toEqual({ relevant: true, destinationHint: null });
  });

  it("part 4: suppresses travelContext entirely when relevant=false but destinationHint was set anyway — a malformed-but-schema-valid decision", async () => {
    const primary = vi.fn<RouterAdapter>(async () => fakeResult("openai", decisionWith({ travelContext: { relevant: false, destinationHint: "somewhere" } })));
    const router = createIntentRouter(primary, primary);

    const result = await router.route(BASE_REQUEST);

    expect(result.decision.travelContext).toEqual({ relevant: false, destinationHint: null });
  });
});

describe("createIntentRouter — EN-083 uncertified-tier gate bypass", () => {
  it("forces curiosityTurn and attestation to no-action when the decision was served by an uncertified provider, even though it validated cleanly", async () => {
    const primary = vi.fn<RouterAdapter>(async () => {
      throw new ProviderAvailabilityError("503", 503);
    });
    const fallback = vi.fn<RouterAdapter>(async () =>
      fakeResult("gemini", decisionWith({ curiosityTurn: { fire: true, kind: "thirdParty", entityId: "c1", attribute: null, probeType: null }, attestation: { isAffirmation: true, entityName: "Elena", attribute: "location", value: "Seattle" } }))
    );
    const router = createIntentRouter(primary, fallback, new Set(["openai"]));

    const result = await router.route(BASE_REQUEST);

    expect(result.provider).toBe("gemini");
    expect(result.decision.curiosityTurn).toEqual({ fire: false, kind: null, entityId: null, attribute: null, probeType: null });
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

  it("ambient context batch, item 1: forces ambientContext to no-action when served by an uncertified provider — real, billed API calls are exactly the consequence EN-083 exists to gate", async () => {
    const primary = vi.fn<RouterAdapter>(async () => {
      throw new ProviderAvailabilityError("503", 503);
    });
    const fallback = vi.fn<RouterAdapter>(async () =>
      fakeResult("gemini", decisionWith({ ambientContext: { relevant: true, ownSituation: true, thirdPartyEntityId: null, namedPlaceForDistance: null } }))
    );
    const router = createIntentRouter(primary, fallback, new Set(["openai"]));

    const result = await router.route(BASE_REQUEST);

    expect(result.decision.ambientContext).toEqual({ relevant: false, ownSituation: false, thirdPartyEntityId: null, namedPlaceForDistance: null });
    expect(result.certified).toBe(false);
  });

  it("keeps ambientContext.relevant when served by the certified tier", async () => {
    const primary = vi.fn<RouterAdapter>(async () =>
      fakeResult("openai", decisionWith({ ambientContext: { relevant: true, ownSituation: true, thirdPartyEntityId: null, namedPlaceForDistance: null } }))
    );
    const router = createIntentRouter(primary, primary, new Set(["openai"]));

    const result = await router.route(BASE_REQUEST);

    expect(result.decision.ambientContext.relevant).toBe(true);
    expect(result.certified).toBe(true);
  });

  it("part 4: forces travelContext to no-action when served by an uncertified provider — a real, billed Routes API call is exactly the consequence EN-083 exists to gate", async () => {
    const primary = vi.fn<RouterAdapter>(async () => {
      throw new ProviderAvailabilityError("503", 503);
    });
    const fallback = vi.fn<RouterAdapter>(async () => fakeResult("gemini", decisionWith({ travelContext: { relevant: true, destinationHint: "the office" } })));
    const router = createIntentRouter(primary, fallback, new Set(["openai"]));

    const result = await router.route(BASE_REQUEST);

    expect(result.decision.travelContext).toEqual({ relevant: false, destinationHint: null });
    expect(result.certified).toBe(false);
  });

  it("part 4: keeps travelContext.relevant when served by the certified tier", async () => {
    const primary = vi.fn<RouterAdapter>(async () => fakeResult("openai", decisionWith({ travelContext: { relevant: true, destinationHint: null } })));
    const router = createIntentRouter(primary, primary, new Set(["openai"]));

    const result = await router.route(BASE_REQUEST);

    expect(result.decision.travelContext.relevant).toBe(true);
    expect(result.certified).toBe(true);
  });
});

describe("SAFE_DEFAULT_DECISION (EN-048)", () => {
  it("defaults register to natural, never zen", () => {
    expect(SAFE_DEFAULT_DECISION.register).toEqual({ mode: "natural" });
  });
});
