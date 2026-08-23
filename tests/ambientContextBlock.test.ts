import { describe, expect, it } from "vitest";
import { buildAmbientContextBlock, buildSystemPrompt } from "../src/persona/systemPrompt.js";

const WEATHER = { temperatureCelsius: 35.3, feelsLikeCelsius: 36, description: "Sunny" };

describe("buildAmbientContextBlock (item 1) — pure formatting of what actually resolved", () => {
  it("returns null when nothing resolved at all — never a placeholder line", () => {
    expect(buildAmbientContextBlock({}, 400)).toBeNull();
  });

  it("renders the owner's own weather and local time", () => {
    const block = buildAmbientContextBlock({ own: { weather: WEATHER, localTime: "2:15 PM" } }, 400)!;
    expect(block).toContain("=== AMBIENT CONTEXT (begin) ===");
    expect(block).toContain("Owner's own weather right now: 35°C (feels like 36°C), Sunny");
    expect(block).toContain("Owner's own local time: 2:15 PM");
  });

  it("renders a third party's weather/local time by name, distinct from the owner's own lines", () => {
    const block = buildAmbientContextBlock({ thirdParty: { name: "Mom", weather: { temperatureCelsius: 38, feelsLikeCelsius: 41, description: "Hot" }, localTime: "4:00 PM" } }, 400)!;
    expect(block).toContain("Mom's weather right now: 38°C (feels like 41°C), Hot");
    expect(block).toContain("Mom's local time: 4:00 PM");
    expect(block).not.toContain("Owner's own");
  });

  it("renders a walking distance", () => {
    const block = buildAmbientContextBlock({ distance: { placeName: "BIG Pharmacy", durationMinutes: 20, distanceMeters: 1600 } }, 400)!;
    expect(block).toContain("Walking distance to BIG Pharmacy: about 20 minutes (1600m)");
  });

  it("only renders what's present — a missing weather but present local time renders just the one line", () => {
    const block = buildAmbientContextBlock({ own: { weather: null, localTime: "2:15 PM" } }, 400)!;
    expect(block).toContain("Owner's own local time: 2:15 PM");
    expect(block).not.toContain("weather");
  });

  it("respects its own tiny budget — omitted (never mangled) if somehow exceeded", () => {
    expect(buildAmbientContextBlock({ own: { weather: WEATHER, localTime: "2:15 PM" } }, 10)).toBeNull();
  });

  it("the worked example: mother's heat + walking distance together, still under two-facts-worth of lines (no readout)", () => {
    const block = buildAmbientContextBlock(
      {
        thirdParty: { name: "Mom", weather: { temperatureCelsius: 38, feelsLikeCelsius: 41, description: "Hot" }, localTime: null },
        distance: { placeName: "BIG Pharmacy", durationMinutes: 20, distanceMeters: 1600 }
      },
      400
    )!;
    expect(block).toContain("Mom's weather right now: 38°C");
    expect(block).toContain("Walking distance to BIG Pharmacy: about 20 minutes");
  });
});

describe("buildSystemPrompt threads the ambient-context block through", () => {
  it("includes the ambient block when supplied, omits it entirely when null", () => {
    const ambientBlock = buildAmbientContextBlock({ own: { weather: WEATHER, localTime: "2:15 PM" } }, 400);
    const withAmbient = buildSystemPrompt("", "", null, "natural", null, null, null, null, ambientBlock);
    expect(withAmbient).toContain("=== AMBIENT CONTEXT (begin) ===");

    const withoutAmbient = buildSystemPrompt("", "", null, "natural", null, null, null, null, null);
    expect(withoutAmbient).not.toContain("=== AMBIENT CONTEXT (begin) ===");
  });
});
