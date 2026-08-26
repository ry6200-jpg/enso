import { afterEach, describe, expect, it, vi } from "vitest";
import { formatPlaceName, reverseGeocode } from "../src/location/reverseGeocode.js";
import { lookupCityFromIp } from "../src/location/ipGeolocation.js";
import { resolveCurrentLocationContext, type CurrentLocationContext } from "../src/location/currentLocation.js";
import { buildLocationContextBlock } from "../src/persona/systemPrompt.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockJsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

describe("formatPlaceName", () => {
  it("combines city and region", () => {
    expect(formatPlaceName({ city: "Los Angeles", stateRegion: "California", country: "United States" })).toBe("Los Angeles, California");
  });

  it("falls back to region + country when there's no city", () => {
    expect(formatPlaceName({ city: null, stateRegion: null, country: "Japan" })).toBe("Japan");
  });

  it("returns null when nothing at all resolved", () => {
    expect(formatPlaceName({ city: null, stateRegion: null, country: null })).toBeNull();
  });
});

describe("reverseGeocode (Tier 1) — mocked fetch, real API shape", () => {
  it("returns null immediately when no API key is configured — never attempts a call", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const result = await reverseGeocode(35.6762, 139.6503, undefined);
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("parses address_components into city/region/country, preferring locality", async () => {
    globalThis.fetch = vi.fn(async () =>
      mockJsonResponse({
        status: "OK",
        results: [{ address_components: [{ long_name: "Tokyo", types: ["locality"] }, { long_name: "Tokyo", types: ["administrative_area_level_1"] }, { long_name: "Japan", types: ["country"] }] }]
      })
    ) as unknown as typeof fetch;

    const result = await reverseGeocode(35.6762, 139.6503, "fake-key");
    expect(result).toEqual({ city: "Tokyo", stateRegion: "Tokyo", country: "Japan" });
  });

  it("falls back to postal_town then sublocality when locality is absent (dense urban core)", async () => {
    globalThis.fetch = vi.fn(async () => mockJsonResponse({ status: "OK", results: [{ address_components: [{ long_name: "Hollywood", types: ["sublocality"] }] }] })) as unknown as typeof fetch;
    const result = await reverseGeocode(34.0928, -118.3287, "fake-key");
    expect(result?.city).toBe("Hollywood");
  });

  it("NEVER includes latitude/longitude in its result, even though it was given them — coordinates-discarded guarantee", async () => {
    globalThis.fetch = vi.fn(async () => mockJsonResponse({ status: "OK", results: [{ address_components: [{ long_name: "Paris", types: ["locality"] }] }] })) as unknown as typeof fetch;
    const result = await reverseGeocode(48.8566, 2.3522, "fake-key");
    expect(result).not.toHaveProperty("latitude");
    expect(result).not.toHaveProperty("longitude");
    expect(Object.keys(result!).sort()).toEqual(["city", "country", "stateRegion"].sort());
  });

  it("returns null on a non-OK API status, never throws", async () => {
    globalThis.fetch = vi.fn(async () => mockJsonResponse({ status: "ZERO_RESULTS", results: [] })) as unknown as typeof fetch;
    expect(await reverseGeocode(0, 0, "fake-key")).toBeNull();
  });

  it("returns null on a network failure, never throws", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await reverseGeocode(0, 0, "fake-key")).toBeNull();
  });
});

describe("lookupCityFromIp (Tier 2) — mocked fetch, keyless ip-api.com", () => {
  it("returns null for a private/local IP without ever calling out — the real local-dev limitation", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    for (const ip of ["127.0.0.1", "::1", "192.168.1.5", "10.0.0.1"]) {
      expect(await lookupCityFromIp(ip)).toBeNull();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns null for a null IP (couldn't be determined)", async () => {
    expect(await lookupCityFromIp(null)).toBeNull();
  });

  it("parses a successful lookup for a real public IP", async () => {
    globalThis.fetch = vi.fn(async () => mockJsonResponse({ status: "success", city: "Tokyo", regionName: "Tokyo", country: "Japan" })) as unknown as typeof fetch;
    expect(await lookupCityFromIp("8.8.8.8")).toEqual({ city: "Tokyo", region: "Tokyo", country: "Japan" });
  });

  it("returns null on a failed lookup status", async () => {
    globalThis.fetch = vi.fn(async () => mockJsonResponse({ status: "fail" })) as unknown as typeof fetch;
    expect(await lookupCityFromIp("8.8.8.8")).toBeNull();
  });
});

describe("resolveCurrentLocationContext — tier priority (best available wins)", () => {
  it("Tier 1 (client-geocoded place name) wins when present", async () => {
    globalThis.fetch = vi.fn(async () => mockJsonResponse({ status: "success", city: "Munich", regionName: "Bavaria", country: "Germany" })) as unknown as typeof fetch;
    const result = await resolveCurrentLocationContext({ placeName: "Tokyo, Japan", timezone: "Asia/Tokyo" }, "8.8.8.8");
    expect(result).toEqual({ placeName: "Tokyo, Japan", tier: "geolocation", timezone: "Asia/Tokyo" });
  });

  it("falls to Tier 2 (IP city) when Tier 1 (geolocation) was denied/unavailable — the real denial path", async () => {
    globalThis.fetch = vi.fn(async () => mockJsonResponse({ status: "success", city: "Munich", regionName: "Bavaria", country: "Germany" })) as unknown as typeof fetch;
    const result = await resolveCurrentLocationContext({ placeName: null, timezone: "Europe/Berlin" }, "8.8.8.8");
    expect(result).toEqual({ placeName: "Munich, Bavaria", tier: "ip", timezone: "Europe/Berlin" });
  });

  it("falls to Tier 3 (timezone only) when neither Tier 1 nor Tier 2 resolved", async () => {
    globalThis.fetch = vi.fn(async () => mockJsonResponse({ status: "fail" })) as unknown as typeof fetch; // e.g. local dev, private IP already short-circuits before this
    const result = await resolveCurrentLocationContext({ placeName: null, timezone: "America/Los_Angeles" }, "127.0.0.1");
    expect(result).toEqual({ placeName: null, tier: "timezone", timezone: "America/Los_Angeles" });
  });

  it("resolves to nothing at all when no tier produced anything — never a guess", async () => {
    const result = await resolveCurrentLocationContext({ placeName: null, timezone: null }, null);
    expect(result).toEqual({ placeName: null, tier: null, timezone: null });
  });
});

describe("buildLocationContextBlock — pure formatting, own budget, never the recent-window budget", () => {
  const GEO: CurrentLocationContext = { placeName: "Tokyo, Japan", tier: "geolocation", timezone: "Asia/Tokyo" };
  const IP: CurrentLocationContext = { placeName: "Berlin, Germany", tier: "ip", timezone: "Europe/Berlin" };
  const TZ_ONLY: CurrentLocationContext = { placeName: null, tier: "timezone", timezone: "America/Los_Angeles" };
  const NONE: CurrentLocationContext = { placeName: null, tier: null, timezone: null };

  it("omits the block entirely when nothing resolved — never a placeholder line", () => {
    expect(buildLocationContextBlock(NONE, 200)).toBeNull();
  });

  it("renders place name with its tier label, and local time, for Tier 1", () => {
    const block = buildLocationContextBlock(GEO, 200)!;
    expect(block).toContain("=== CURRENT CONTEXT (begin) ===");
    expect(block).toContain("Location: Tokyo, Japan (via device GPS)");
    expect(block).toMatch(/Local time: \d{1,2} [AP]M/);
  });

  it("renders the IP tier with its own label, distinct from geolocation", () => {
    const block = buildLocationContextBlock(IP, 200)!;
    expect(block).toContain("Location: Berlin, Germany (via approximate network location)");
  });

  it("Tier 3 (timezone only): local time only, explicitly notes location isn't available, never fabricates a place", () => {
    const block = buildLocationContextBlock(TZ_ONLY, 200)!;
    expect(block).not.toMatch(/Location:/);
    expect(block).toMatch(/Local time: \d{1,2} [AP]M \(timezone only — location not available\)/);
  });

  it("omits the whole block (never a partial render) when it would exceed its own budget", () => {
    expect(buildLocationContextBlock(GEO, 5)).toBeNull();
  });

  it("an invalid/unrecognized timezone string never crashes — degrades to omitting the time line", () => {
    const bad: CurrentLocationContext = { placeName: "Somewhere", tier: "geolocation", timezone: "Not/A_Real_Zone" };
    expect(() => buildLocationContextBlock(bad, 200)).not.toThrow();
    const block = buildLocationContextBlock(bad, 200);
    expect(block).toContain("Location: Somewhere");
    expect(block).not.toContain("Local time");
  });
});
