import { afterEach, describe, expect, it, vi } from "vitest";
import { getDrivingRoute } from "../src/location/drivingRoute.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

const ORIGIN = { lat: 34.0522, lng: -118.2437 };
const DEST = { lat: 47.6062, lng: -122.3321 };

describe("getDrivingRoute logging (EN-112 diagnostic-blind-spot fix) — behavior unchanged, only observability added", () => {
  it("no API key: makes no call and logs nothing — this is not an 'attempt'", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await getDrivingRoute(ORIGIN.lat, ORIGIN.lng, DEST.lat, DEST.lng, undefined);

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("logs the attempt before the call, and logs success with the resolved duration — still returns the same value as before", async () => {
    globalThis.fetch = vi.fn(async () => mockResponse({ routes: [{ duration: "1800s", distanceMeters: 24000 }] })) as unknown as typeof fetch;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await getDrivingRoute(ORIGIN.lat, ORIGIN.lng, DEST.lat, DEST.lng, "fake-key");

    expect(result).toEqual({ durationMinutes: 30, distanceMeters: 24000 });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("calling computeRoutes"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("succeeded"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("durationMinutes=30"));
  });

  it("a non-ok response (e.g. REQUEST_DENIED/PERMISSION_DENIED/quota) is logged with its HTTP status, and still returns null exactly as before", async () => {
    globalThis.fetch = vi.fn(async () => mockResponse({ error: { status: "PERMISSION_DENIED" } }, false, 403)) as unknown as typeof fetch;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await getDrivingRoute(ORIGIN.lat, ORIGIN.lng, DEST.lat, DEST.lng, "fake-key");

    expect(result).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("HTTP 403"));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("PERMISSION_DENIED"));
  });

  it("a response with no usable route is logged distinctly from an HTTP failure, and still returns null", async () => {
    globalThis.fetch = vi.fn(async () => mockResponse({ routes: [] })) as unknown as typeof fetch;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await getDrivingRoute(ORIGIN.lat, ORIGIN.lng, DEST.lat, DEST.lng, "fake-key");

    expect(result).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("no usable route"));
  });

  it("a thrown error (network failure, timeout) is logged, and still returns null exactly as before", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network unreachable");
    }) as unknown as typeof fetch;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await getDrivingRoute(ORIGIN.lat, ORIGIN.lng, DEST.lat, DEST.lng, "fake-key");

    expect(result).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("network unreachable"));
  });

  it("never logs the API key", async () => {
    globalThis.fetch = vi.fn(async () => mockResponse({ error: "denied" }, false, 403)) as unknown as typeof fetch;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const secretKey = "AIzaSySECRETVALUEshouldNeverAppearInLogs";

    await getDrivingRoute(ORIGIN.lat, ORIGIN.lng, DEST.lat, DEST.lng, secretKey);

    const allCalls = [...logSpy.mock.calls, ...errorSpy.mock.calls].flat().join(" ");
    expect(allCalls).not.toContain(secretKey);
  });
});
