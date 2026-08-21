import { describe, expect, it } from "vitest";
import { ClientRequestError, ProviderAvailabilityError, classifyProviderError } from "../src/providers/errors.js";

describe("classifyProviderError (EN-083)", () => {
  it("classifies 5xx as an availability error (falls back)", () => {
    const result = classifyProviderError({ status: 503, message: "Service Unavailable" });
    expect(result).toBeInstanceOf(ProviderAvailabilityError);
    expect(result.status).toBe(503);
  });

  it("classifies 429 as an availability error, not a client error, despite being a 4xx", () => {
    const result = classifyProviderError({ status: 429, message: "Too Many Requests" });
    expect(result).toBeInstanceOf(ProviderAvailabilityError);
  });

  it("classifies ordinary 4xx (400, 401, 404, 422) as client errors — never fall back on these", () => {
    for (const status of [400, 401, 404, 422]) {
      const result = classifyProviderError({ status, message: "bad request" });
      expect(result).toBeInstanceOf(ClientRequestError);
      expect(result.status).toBe(status);
    }
  });

  it("classifies an error with no status (network failure, timeout, DNS) as availability", () => {
    const result = classifyProviderError(new Error("fetch failed: ECONNRESET"));
    expect(result).toBeInstanceOf(ProviderAvailabilityError);
    expect(result.status).toBeUndefined();
  });

  it("reads status from a nested response.status shape", () => {
    const result = classifyProviderError({ response: { status: 502 }, message: "bad gateway" });
    expect(result).toBeInstanceOf(ProviderAvailabilityError);
    expect(result.status).toBe(502);
  });

  it("reads status from a numeric .code field (the @google/genai ApiError shape)", () => {
    const result = classifyProviderError({ code: 503, message: "high demand" });
    expect(result).toBeInstanceOf(ProviderAvailabilityError);
    expect(result.status).toBe(503);
  });
});
