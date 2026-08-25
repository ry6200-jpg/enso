import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAmbientTravelContext } from "../src/conversation/ambientTravelFetch.js";
import type { RouterDecision } from "../src/conversation/router/routerTypes.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockJsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

const NO_ACTION: RouterDecision["travelContext"] = { relevant: false, destinationHint: null };
const ORIGIN = { latitude: 34.0522, longitude: -118.2437 };

describe("fetchAmbientTravelContext (part 4) — the actual API calls, gated by the router decision", () => {
  it("makes ZERO calls when relevant is false — the governing rule, enforced structurally", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const result = await fetchAmbientTravelContext({ decision: NO_ACTION, ownCoordinates: ORIGIN, primaryResidence: "Seattle", apiKey: "fake-key" });
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("makes ZERO calls when relevant is true but no origin coordinates are available this turn — origin comes only from the existing ambient tiers", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const result = await fetchAmbientTravelContext({ decision: { relevant: true, destinationHint: null }, ownCoordinates: null, primaryResidence: "Seattle", apiKey: "fake-key" });
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("makes ZERO calls when relevant is true, no destinationHint, and no primary residence on record — nothing to resolve to", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const result = await fetchAmbientTravelContext({ decision: { relevant: true, destinationHint: null }, ownCoordinates: ORIGIN, primaryResidence: null, apiKey: "fake-key" });
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("falls back to the primary user's own residence (geocoded directly) when no specific place was named this turn", async () => {
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("geocode")) return mockJsonResponse({ status: "OK", results: [{ geometry: { location: { lat: 47.6, lng: -122.3 } } }] });
      if (url.includes("computeRoutes")) {
        const body = JSON.parse(init!.body as string);
        expect(body.travelMode).toBe("DRIVE");
        expect(body.routingPreference).toBe("TRAFFIC_AWARE");
        expect(body.origin.location.latLng.latitude).toBe(ORIGIN.latitude);
        expect(body.destination.location.latLng.latitude).toBe(47.6);
        return mockJsonResponse({ routes: [{ duration: "1800s", distanceMeters: 24000 }] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const result = await fetchAmbientTravelContext({ decision: { relevant: true, destinationHint: null }, ownCoordinates: ORIGIN, primaryResidence: "Seattle", apiKey: "fake-key" });

    expect(result).toEqual({ destinationLabel: "Seattle", durationMinutes: 30, distanceMeters: 24000 });
  });

  it("resolves a specific named destination via Places search (biased near the origin), ignoring the residence fallback entirely", async () => {
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("searchText")) {
        const body = JSON.parse(init!.body as string);
        expect(body.textQuery).toBe("the airport");
        return mockJsonResponse({ places: [{ displayName: { text: "LAX" }, formattedAddress: "addr", location: { latitude: 33.94, longitude: -118.4 } }] });
      }
      if (url.includes("computeRoutes")) {
        const body = JSON.parse(init!.body as string);
        expect(body.destination.location.latLng.latitude).toBe(33.94);
        return mockJsonResponse({ routes: [{ duration: "1500s", distanceMeters: 20000 }] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const result = await fetchAmbientTravelContext({ decision: { relevant: true, destinationHint: "the airport" }, ownCoordinates: ORIGIN, primaryResidence: "Seattle", apiKey: "fake-key" });

    expect(result).toEqual({ destinationLabel: "the airport", durationMinutes: 25, distanceMeters: 20000 });
  });

  it("HONESTY: an unresolvable destinationHint (Places search comes back empty) makes no travel call, never falls back to the residence silently", async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.includes("searchText")) return mockJsonResponse({ places: [] });
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const result = await fetchAmbientTravelContext({ decision: { relevant: true, destinationHint: "my mom's place" }, ownCoordinates: ORIGIN, primaryResidence: "Seattle", apiKey: "fake-key" });

    expect(result).toBeNull();
  });

  it("HONESTY: destination resolves fine but the Routes call itself fails — the whole result is still null, never an estimate", async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.includes("searchText")) return mockJsonResponse({ places: [{ displayName: { text: "LAX" }, formattedAddress: "addr", location: { latitude: 33.94, longitude: -118.4 } }] });
      if (url.includes("computeRoutes")) return mockJsonResponse({}, false);
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;
    const result = await fetchAmbientTravelContext({ decision: { relevant: true, destinationHint: "the airport" }, ownCoordinates: ORIGIN, primaryResidence: "Seattle", apiKey: "fake-key" });
    expect(result).toBeNull();
  });

  describe("EN-112 diagnostic-blind-spot fix: which destination path was taken is now logged, fallback behavior itself unchanged", () => {
    it("logs 'explicit destinationHint' when a specific place was named — same result as before", async () => {
      globalThis.fetch = vi.fn(async (url: string) => {
        if (url.includes("searchText")) return mockJsonResponse({ places: [{ displayName: { text: "LAX" }, formattedAddress: "addr", location: { latitude: 33.94, longitude: -118.4 } }] });
        if (url.includes("computeRoutes")) return mockJsonResponse({ routes: [{ duration: "1500s", distanceMeters: 20000 }] });
        throw new Error(`unexpected fetch: ${url}`);
      }) as unknown as typeof fetch;
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const result = await fetchAmbientTravelContext({ decision: { relevant: true, destinationHint: "the airport" }, ownCoordinates: ORIGIN, primaryResidence: "Seattle", apiKey: "fake-key" });

      expect(result).toEqual({ destinationLabel: "the airport", durationMinutes: 25, distanceMeters: 20000 });
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("explicit destinationHint"));
    });

    it("logs the entity_attributes.location fallback when no destinationHint was stated — same result as before, and never logs the actual residence value", async () => {
      globalThis.fetch = vi.fn(async (url: string) => {
        if (url.includes("geocode")) return mockJsonResponse({ status: "OK", results: [{ geometry: { location: { lat: 47.6, lng: -122.3 } } }] });
        if (url.includes("computeRoutes")) return mockJsonResponse({ routes: [{ duration: "1800s", distanceMeters: 24000 }] });
        throw new Error(`unexpected fetch: ${url}`);
      }) as unknown as typeof fetch;
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const result = await fetchAmbientTravelContext({ decision: { relevant: true, destinationHint: null }, ownCoordinates: ORIGIN, primaryResidence: "1600 Amphitheatre Parkway", apiKey: "fake-key" });

      expect(result).toEqual({ destinationLabel: "1600 Amphitheatre Parkway", durationMinutes: 30, distanceMeters: 24000 });
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("fallback"));
      const allLogged = logSpy.mock.calls.flat().join(" ");
      expect(allLogged).not.toContain("1600 Amphitheatre Parkway");
    });
  });
});
