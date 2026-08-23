import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAmbientContext } from "../src/conversation/ambientContextFetch.js";
import type { RouterDecision } from "../src/conversation/router/routerTypes.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockJsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

const NO_ACTION: RouterDecision["ambientContext"] = { relevant: false, ownSituation: false, thirdPartyEntityId: null, namedPlaceForDistance: null };

describe("fetchAmbientContext (item 1) — the actual API calls, gated by the router decision", () => {
  it("makes ZERO calls of any kind when relevant is false — the governing rule, enforced structurally", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const result = await fetchAmbientContext({ decision: NO_ACTION, ownCoordinates: { latitude: 1, longitude: 1 }, candidates: [], apiKey: "fake-key" });
    expect(result).toEqual({});
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("ownSituation=true fetches weather + local time for the owner's own coordinates", async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.includes("weather.googleapis.com")) return mockJsonResponse({ temperature: { degrees: 35.3 }, feelsLikeTemperature: { degrees: 36 }, weatherCondition: { description: { text: "Sunny" } } });
      if (url.includes("timezone")) return mockJsonResponse({ status: "OK", timeZoneId: "America/Los_Angeles" });
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const result = await fetchAmbientContext({
      decision: { relevant: true, ownSituation: true, thirdPartyEntityId: null, namedPlaceForDistance: null },
      ownCoordinates: { latitude: 34.0522, longitude: -118.2437 },
      candidates: [],
      apiKey: "fake-key"
    });

    expect(result.own?.weather).toEqual({ temperatureCelsius: 35.3, feelsLikeCelsius: 36, description: "Sunny" });
    expect(result.own?.localTime).toMatch(/^\d{1,2}:\d{2}\s?(AM|PM)$/);
    expect(result.thirdParty).toBeUndefined();
    expect(result.distance).toBeUndefined();
  });

  it("ownSituation=true but no coordinates available makes no calls — nothing to fetch", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const result = await fetchAmbientContext({
      decision: { relevant: true, ownSituation: true, thirdPartyEntityId: null, namedPlaceForDistance: null },
      ownCoordinates: null,
      candidates: [],
      apiKey: "fake-key"
    });
    expect(result.own).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("thirdPartyEntityId geocodes the candidate's stored location, then fetches weather + local time for it", async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.includes("geocode")) return mockJsonResponse({ status: "OK", results: [{ geometry: { location: { lat: 1.5245, lng: 103.64 } } }] });
      if (url.includes("weather.googleapis.com")) return mockJsonResponse({ temperature: { degrees: 25.8 }, feelsLikeTemperature: { degrees: 28.7 }, weatherCondition: { description: { text: "Clear" } } });
      if (url.includes("timezone")) return mockJsonResponse({ status: "OK", timeZoneId: "Asia/Kuala_Lumpur" });
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const result = await fetchAmbientContext({
      decision: { relevant: true, ownSituation: false, thirdPartyEntityId: "e1", namedPlaceForDistance: null },
      ownCoordinates: null,
      candidates: [{ entityId: "e1", name: "Mom", location: "Taman Mutiara Rini, Johor Bahru" }],
      apiKey: "fake-key"
    });

    expect(result.thirdParty?.name).toBe("Mom");
    expect(result.thirdParty?.weather).toEqual({ temperatureCelsius: 25.8, feelsLikeCelsius: 28.7, description: "Clear" });
    expect(result.own).toBeUndefined();
  });

  it("thirdPartyEntityId not found in candidates (validation should already prevent this, but defense in depth) resolves nothing", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const result = await fetchAmbientContext({
      decision: { relevant: true, ownSituation: false, thirdPartyEntityId: "nonexistent", namedPlaceForDistance: null },
      ownCoordinates: null,
      candidates: [],
      apiKey: "fake-key"
    });
    expect(result.thirdParty).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("namedPlaceForDistance resolves the place and computes walking distance FROM THE OWNER when no third party is also relevant", async () => {
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("searchText")) return mockJsonResponse({ places: [{ displayName: { text: "BIG Pharmacy" }, formattedAddress: "addr", location: { latitude: 1.51, longitude: 103.66 } }] });
      if (url.includes("computeRoutes")) {
        const body = JSON.parse(init!.body as string);
        expect(body.origin.location.latLng.latitude).toBe(34.0522); // the OWNER's coordinates, not a third party's
        return mockJsonResponse({ routes: [{ duration: "1200s", distanceMeters: 1600 }] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const result = await fetchAmbientContext({
      decision: { relevant: true, ownSituation: false, thirdPartyEntityId: null, namedPlaceForDistance: "BIG Pharmacy" },
      ownCoordinates: { latitude: 34.0522, longitude: -118.2437 },
      candidates: [],
      apiKey: "fake-key"
    });

    expect(result.distance).toEqual({ placeName: "BIG Pharmacy", durationMinutes: 20, distanceMeters: 1600 });
  });

  it("namedPlaceForDistance computes distance FROM THE THIRD PARTY when one is also relevant this turn — the worked example's exact shape", async () => {
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("geocode")) return mockJsonResponse({ status: "OK", results: [{ geometry: { location: { lat: 1.5245, lng: 103.64 } } }] });
      if (url.includes("weather.googleapis.com")) return mockJsonResponse({ temperature: { degrees: 38 }, feelsLikeTemperature: { degrees: 41 }, weatherCondition: { description: { text: "Hot" } } });
      if (url.includes("timezone")) return mockJsonResponse({ status: "OK", timeZoneId: "Asia/Kuala_Lumpur" });
      if (url.includes("searchText")) return mockJsonResponse({ places: [{ displayName: { text: "BIG Pharmacy" }, formattedAddress: "addr", location: { latitude: 1.51, longitude: 103.66 } }] });
      if (url.includes("computeRoutes")) {
        const body = JSON.parse(init!.body as string);
        // The mother's geocoded coordinates, NOT the owner's own — this is the worked example exactly.
        expect(body.origin.location.latLng.latitude).toBe(1.5245);
        return mockJsonResponse({ routes: [{ duration: "1200s", distanceMeters: 1600 }] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const result = await fetchAmbientContext({
      decision: { relevant: true, ownSituation: false, thirdPartyEntityId: "mom", namedPlaceForDistance: "BIG Pharmacy" },
      ownCoordinates: { latitude: 34.0522, longitude: -118.2437 }, // the owner's own — must NOT be used as the distance origin here
      candidates: [{ entityId: "mom", name: "Mom", location: "Taman Mutiara Rini, Johor Bahru" }],
      apiKey: "fake-key"
    });

    expect(result.distance?.placeName).toBe("BIG Pharmacy");
    expect(result.thirdParty?.weather?.temperatureCelsius).toBe(38);
  });

  it("HONESTY: a failed weather call leaves that data point simply absent, never an estimate", async () => {
    globalThis.fetch = vi.fn(async () => mockJsonResponse({}, false)) as unknown as typeof fetch;
    const result = await fetchAmbientContext({
      decision: { relevant: true, ownSituation: true, thirdPartyEntityId: null, namedPlaceForDistance: null },
      ownCoordinates: { latitude: 34.0522, longitude: -118.2437 },
      candidates: [],
      apiKey: "fake-key"
    });
    expect(result.own).toBeUndefined();
  });
});
