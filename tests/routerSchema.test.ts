import { describe, expect, it } from "vitest";
import { ROUTER_JSON_SCHEMA, buildRouterSystemPrompt } from "../src/conversation/router/routerSchema.js";
import type { RouterRequest } from "../src/conversation/router/routerTypes.js";

const BASE_REQUEST: RouterRequest = {
  message: "hello",
  recentTurns: [],
  knownEntities: [],
  curiosityTurnEligible: true,
  curiosityCandidates: [],
  recentAttributeClaims: []
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
    expect(prompt).toMatch(/4\. REGISTER/);
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
    expect(schema.properties.kind.enum).toEqual(["selfFact", "thirdParty", "connectDot", null]);
    expect(schema.properties.attribute.enum).toEqual(["location", "occupation", null]);
    expect(schema.required).toEqual(["fire", "kind", "entityId", "attribute"]);
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
