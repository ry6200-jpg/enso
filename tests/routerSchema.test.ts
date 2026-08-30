import { describe, expect, it } from "vitest";
import { ROUTER_JSON_SCHEMA, buildRouterSystemPrompt } from "../src/conversation/router/routerSchema.js";
import type { RouterRequest } from "../src/conversation/router/routerTypes.js";

const BASE_REQUEST: RouterRequest = {
  message: "hello",
  recentTurns: [],
  knownEntities: [],
  curiosityTurnEligible: true,
  curiosityCandidates: [],
  recentAttributeClaims: [],
  ambientLocationCandidates: [],
  ownLocationAvailable: false,
  primaryResidenceKnown: false,
  coReferencePendingCandidates: [],
  coReferenceConfirmedPairings: [],
  coReferenceAskCandidates: [],
  mergePendingProposal: null,
  typoMergeAskCandidates: [],
  typoMergePendingCandidates: []
};

describe("ROUTER_JSON_SCHEMA (EN-048's register axis)", () => {
  it("includes a register property with a natural/zen enum, required, strict schema", () => {
    const registerSchema = (ROUTER_JSON_SCHEMA.properties as Record<string, unknown>).register as {
      properties: { mode: { enum: readonly string[] } };
      required: readonly string[];
      additionalProperties: boolean;
    };
    expect(registerSchema.properties.mode.enum).toEqual(["natural", "zen"]);
    expect(registerSchema.required).toEqual(["mode"]);
    expect(registerSchema.additionalProperties).toBe(false);
  });

  it("register is a required top-level property, same strict treatment as the other three axes", () => {
    expect(ROUTER_JSON_SCHEMA.required).toContain("register");
    expect(ROUTER_JSON_SCHEMA.additionalProperties).toBe(false);
  });
});

describe("buildRouterSystemPrompt (EN-048's register section)", () => {
  it("instructs the router to default to natural and judge zen from content, not a trigger word", () => {
    const prompt = buildRouterSystemPrompt(BASE_REQUEST);
    expect(prompt).toMatch(/8\. REGISTER/);
    expect(prompt).toMatch(/Default to "natural"/);
    expect(prompt).toMatch(/not from whether it contains a specific trigger word/);
  });
});

describe("ROUTER_JSON_SCHEMA (EN-030 curiosityTurn axis)", () => {
  it("includes a curiosityTurn property with kind/entityId/attribute, required, strict schema", () => {
    const schema = (ROUTER_JSON_SCHEMA.properties as Record<string, unknown>).curiosityTurn as {
      properties: { kind: { enum: readonly (string | null)[] }; attribute: { enum: readonly (string | null)[] } };
      required: readonly string[];
      additionalProperties: boolean;
    };
    expect(schema.properties.kind.enum).toEqual(["selfFact", "thirdParty", "connectDot", "elicitation", null]);
    expect(schema.properties.attribute.enum).toEqual(["location", "occupation", null]);
    expect(schema.required).toEqual(["fire", "kind", "entityId", "attribute", "probeType"]);
    expect(schema.additionalProperties).toBe(false);
  });

  it("curiosityTurn is a required top-level property", () => {
    expect(ROUTER_JSON_SCHEMA.required).toContain("curiosityTurn");
    expect(ROUTER_JSON_SCHEMA.required).not.toContain("circleBack");
  });
});

describe("buildRouterSystemPrompt (EN-030 curiosityTurn section)", () => {
  it("states curiosityTurnEligible plainly and forces fire=false/kind=null when it's false", () => {
    const prompt = buildRouterSystemPrompt({ ...BASE_REQUEST, curiosityTurnEligible: false });
    expect(prompt).toMatch(/curiosityTurnEligible this turn: false/);
    expect(prompt).toMatch(/fire MUST be false and kind MUST be null/);
  });

  it("lists selfFact and thirdParty candidates distinctly, tagged for the model to match against", () => {
    const prompt = buildRouterSystemPrompt({
      ...BASE_REQUEST,
      curiosityCandidates: [
        { kind: "selfFact", attribute: "occupation" },
        { kind: "thirdParty", candidate: { entityId: "c1", name: "Marcus", attemptNumber: 1, mentionAgeLabel: "earlier today", stableKey: "s1" } }
      ]
    });
    expect(prompt).toMatch(/\[selfFact\] attribute="occupation"/);
    expect(prompt).toMatch(/\[thirdParty\] Marcus \(id: c1\)/);
  });

  it("offers connectDot as a first-class alternative, not conditioned on the ask-candidate list being empty", () => {
    const prompt = buildRouterSystemPrompt(BASE_REQUEST);
    expect(prompt).toMatch(/kind="connectDot"/);
    expect(prompt).toMatch(/never invent one to fill the slot/);
  });
});

describe("ROUTER_JSON_SCHEMA (part 4: travelContext axis)", () => {
  it("includes a travelContext property with relevant/destinationHint, required, strict schema", () => {
    const schema = (ROUTER_JSON_SCHEMA.properties as Record<string, unknown>).travelContext as {
      properties: { relevant: { type: string }; destinationHint: { type: readonly string[] } };
      required: readonly string[];
      additionalProperties: boolean;
    };
    expect(schema.properties.relevant.type).toBe("boolean");
    expect(schema.properties.destinationHint.type).toEqual(["string", "null"]);
    expect(schema.required).toEqual(["relevant", "destinationHint"]);
    expect(schema.additionalProperties).toBe(false);
  });

  it("travelContext is a required top-level property", () => {
    expect(ROUTER_JSON_SCHEMA.required).toContain("travelContext");
  });
});

describe("buildRouterSystemPrompt (part 4: travelContext section)", () => {
  it("names the governing rule (a real timing/attendance decision, not mere knowability) and states whether a residence is on record", () => {
    const prompt = buildRouterSystemPrompt({ ...BASE_REQUEST, primaryResidenceKnown: true });
    expect(prompt).toMatch(/10\. TRAVEL CONTEXT/);
    expect(prompt).toMatch(/Owner's own home\/residence on record: yes/);
    expect(prompt).toMatch(/never "a destination is knowable, so check it\."/);
  });

  it("states 'no' plainly when no residence is on record", () => {
    const prompt = buildRouterSystemPrompt({ ...BASE_REQUEST, primaryResidenceKnown: false });
    expect(prompt).toMatch(/Owner's own home\/residence on record: no/);
  });

  it("never volunteers ETAs as the prompt's own concern — that discipline lives in the persona instruction, not the router prompt (see personaInstructions tests)", () => {
    const prompt = buildRouterSystemPrompt(BASE_REQUEST);
    expect(prompt).toMatch(/destinationHint/);
  });

  it("EN-118: the residence-fallback description is anchored to what it actually requires (heading home specifically), not an abstract 'this is how the mechanism works' sentence sitting in context every turn", () => {
    const prompt = buildRouterSystemPrompt(BASE_REQUEST);
    // The old abstract-mechanism sentence is gone (1b: same fault as AMBIENT_TRAVEL_INSTRUCTION's old "may include").
    expect(prompt).not.toMatch(/the owner's own stated residence is used automatically as the default destination when one is on record/);
    // Replaced with an explicit gate: null is only correct when the moment specifically implies home.
    expect(prompt).toMatch(/Leave destinationHint null ONLY when relevant is true AND the moment specifically implies the owner heading to their OWN home/);
  });

  it("the fallback must not fire on a vague remark with no sense of where — the router is told to set relevant=false rather than guess at an unnamed destination", () => {
    const prompt = buildRouterSystemPrompt(BASE_REQUEST);
    expect(prompt).toMatch(/A general timing\/attendance decision with no sense of WHERE/);
    expect(prompt).toMatch(/set relevant=false instead of guessing at a destination that was never actually there/);
  });
});
