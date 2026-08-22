import { describe, expect, it } from "vitest";
import { ROUTER_JSON_SCHEMA, buildRouterSystemPrompt } from "../src/conversation/router/routerSchema.js";
import type { RouterRequest } from "../src/conversation/router/routerTypes.js";

const BASE_REQUEST: RouterRequest = {
  message: "hello",
  recentTurns: [],
  knownEntities: [],
  circleBackCandidates: [],
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
