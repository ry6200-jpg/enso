import { afterEach, describe, expect, it, vi } from "vitest";
import { getCurrentWeather } from "../src/location/weather.js";
import { formatLocalTime, getTimeZoneId } from "../src/location/timeZoneLookup.js";
import { getWalkingRoute } from "../src/location/walkingRoute.js";
import { findPlaceByName, searchNearbyPlaces } from "../src/location/placesSearch.js";
import { geocodePlaceName } from "../src/location/reverseGeocode.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockJsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

// All mock bodies below are the REAL response shapes captured from live
// calls against Johor Bahru / Los Angeles coordinates before this batch's
// code was written (see the batch report) — not guessed from docs.

describe("getCurrentWeather (item 1) — mocked fetch, real API shape", () => {
  it("returns null immediately when no API key is configured — never attempts a call", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    expect(await getCurrentWeather(1.529, 103.657, undefined)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("parses the real currentConditions:lookup shape (Johor Bahru, verified live)", async () => {
    globalThis.fetch = vi.fn(async () =>
      mockJsonResponse({
        timeZone: { id: "Asia/Kuala_Lumpur", version: "" },
        weatherCondition: { iconBaseUri: "x", description: { text: "Clear with periodic clouds", languageCode: "en" }, type: "MOSTLY_CLEAR" },
        temperature: { unit: "CELSIUS", degrees: 25.8 },
        feelsLikeTemperature: { unit: "CELSIUS", degrees: 28.7 }
      })
    ) as unknown as typeof fetch;

    const result = await getCurrentWeather(1.529, 103.657, "fake-key");
    expect(result).toEqual({ temperatureCelsius: 25.8, feelsLikeCelsius: 28.7, description: "Clear with periodic clouds" });
  });

  it("returns null when a required field is missing, never a partial guess", async () => {
    globalThis.fetch = vi.fn(async () => mockJsonResponse({ temperature: { degrees: 25.8 } })) as unknown as typeof fetch;
    expect(await getCurrentWeather(1.529, 103.657, "fake-key")).toBeNull();
  });

  it("returns null on a non-ok response or network failure, never throws", async () => {
    globalThis.fetch = vi.fn(async () => mockJsonResponse({}, false)) as unknown as typeof fetch;
    expect(await getCurrentWeather(0, 0, "fake-key")).toBeNull();
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await getCurrentWeather(0, 0, "fake-key")).toBeNull();
  });
});

describe("getTimeZoneId / formatLocalTime (item 1) — mocked fetch, real API shape", () => {
  it("parses the real Time Zone API shape (Johor Bahru, verified live)", async () => {
    globalThis.fetch = vi.fn(async () =>
      mockJsonResponse({ dstOffset: 0, rawOffset: 28800, status: "OK", timeZoneId: "Asia/Kuala_Lumpur", timeZoneName: "Malaysia Time" })
    ) as unknown as typeof fetch;
    expect(await getTimeZoneId(1.529, 103.657, "fake-key")).toBe("Asia/Kuala_Lumpur");
  });

  it("returns null on a non-OK status, never throws", async () => {
    globalThis.fetch = vi.fn(async () => mockJsonResponse({ status: "ZERO_RESULTS" })) as unknown as typeof fetch;
    expect(await getTimeZoneId(0, 0, "fake-key")).toBeNull();
  });

  it("formatLocalTime renders a real IANA zone to a plain time string, hour granularity only", () => {
    const formatted = formatLocalTime("Asia/Kuala_Lumpur", new Date("2026-08-23T05:00:00Z"));
    expect(formatted).toMatch(/^\d{1,2}\s?(AM|PM)$/);
  });

  it("formatLocalTime returns null for an invalid zone id rather than a wrong guessed time", () => {
    expect(formatLocalTime("Not/A_Real_Zone")).toBeNull();
  });

  it("prompt-cache fix: renders byte-identical across two calls a few minutes apart, within the same hour", () => {
    const early = formatLocalTime("America/Los_Angeles", new Date("2026-08-23T21:03:00Z"));
    const late = formatLocalTime("America/Los_Angeles", new Date("2026-08-23T21:58:00Z"));
    expect(early).toBe(late);
    expect(early).toBe("2 PM");
  });

  it("prompt-cache fix: still changes the moment a call crosses an hour boundary — a real bound, not frozen forever", () => {
    const beforeBoundary = formatLocalTime("America/Los_Angeles", new Date("2026-08-23T21:59:00Z"));
    const afterBoundary = formatLocalTime("America/Los_Angeles", new Date("2026-08-23T22:02:00Z"));
    expect(beforeBoundary).not.toBe(afterBoundary);
    expect(beforeBoundary).toBe("2 PM");
    expect(afterBoundary).toBe("3 PM");
  });
});

describe("getWalkingRoute (item 1) — mocked fetch, real API shape", () => {
  it("parses the real computeRoutes shape (WALK mode, verified live), converting duration string to minutes", async () => {
    globalThis.fetch = vi.fn(async () => mockJsonResponse({ routes: [{ duration: "1269s", distanceMeters: 1492 }] })) as unknown as typeof fetch;
    const result = await getWalkingRoute(34.0522, -118.2437, 34.0407, -118.2468, "fake-key");
    expect(result).toEqual({ durationMinutes: 21, distanceMeters: 1492 });
  });

  it("returns null when no route is found, never estimates one", async () => {
    globalThis.fetch = vi.fn(async () => mockJsonResponse({ routes: [] })) as unknown as typeof fetch;
    expect(await getWalkingRoute(0, 0, 1, 1, "fake-key")).toBeNull();
  });

  it("sends a WALK-mode request with a minimal field mask (never pulls polylines/steps it doesn't use)", async () => {
    const fetchSpy = vi.fn(async () => mockJsonResponse({ routes: [{ duration: "60s", distanceMeters: 100 }] }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await getWalkingRoute(0, 0, 1, 1, "fake-key");
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.travelMode).toBe("WALK");
    expect((init.headers as Record<string, string>)["X-Goog-FieldMask"]).toBe("routes.duration,routes.distanceMeters");
  });
});

describe("findPlaceByName / searchNearbyPlaces (item 1) — mocked fetch, real API shape", () => {
  const REAL_PLACE = {
    displayName: { text: "BIG Pharmacy Taman Sutera Utama", languageCode: "en" },
    formattedAddress: "38 GF, Jalan Sutera Tanjung 8/4, Taman Sutera Utama, 81300 Skudai, Johor Darul Ta'zim, Malaysia",
    location: { latitude: 1.5166853, longitude: 103.6682837 }
  };

  it("findPlaceByName parses the real searchText shape (verified live)", async () => {
    globalThis.fetch = vi.fn(async () => mockJsonResponse({ places: [REAL_PLACE] })) as unknown as typeof fetch;
    const result = await findPlaceByName("BIG Pharmacy Taman Sutera Utama", 1.529, 103.657, "fake-key");
    expect(result).toEqual({ name: "BIG Pharmacy Taman Sutera Utama", address: REAL_PLACE.formattedAddress, latitude: 1.5166853, longitude: 103.6682837 });
  });

  it("returns null when nothing resolves", async () => {
    globalThis.fetch = vi.fn(async () => mockJsonResponse({ places: [] })) as unknown as typeof fetch;
    expect(await findPlaceByName("nowhere real", 0, 0, "fake-key")).toBeNull();
  });

  it("searchNearbyPlaces parses the real searchNearby shape (verified live), filtering out any incomplete entry", async () => {
    globalThis.fetch = vi.fn(async () => mockJsonResponse({ places: [REAL_PLACE, { displayName: { text: "incomplete" } }] })) as unknown as typeof fetch;
    const result = await searchNearbyPlaces("pharmacy", 1.529, 103.657, "fake-key");
    expect(result).toEqual([{ name: "BIG Pharmacy Taman Sutera Utama", address: REAL_PLACE.formattedAddress, latitude: 1.5166853, longitude: 103.6682837 }]);
  });
});

describe("geocodePlaceName (item 1) — mocked fetch, real API shape", () => {
  it("parses the real forward-geocode shape (Taman Mutiara Rini, Johor Bahru, verified live)", async () => {
    globalThis.fetch = vi.fn(async () => mockJsonResponse({ status: "OK", results: [{ geometry: { location: { lat: 1.524528, lng: 103.6402729 } } }] })) as unknown as typeof fetch;
    expect(await geocodePlaceName("Taman Mutiara Rini, Johor Bahru", "fake-key")).toEqual({ latitude: 1.524528, longitude: 103.6402729 });
  });

  it("returns null when the address doesn't resolve", async () => {
    globalThis.fetch = vi.fn(async () => mockJsonResponse({ status: "ZERO_RESULTS", results: [] })) as unknown as typeof fetch;
    expect(await geocodePlaceName("nowhere real", "fake-key")).toBeNull();
  });
});
