import { describe, expect, it, vi } from "vitest";
import { ClientRequestError, ProviderAvailabilityError } from "../src/providers/errors.js";
import { retryWithBackoff } from "../src/extraction/retry.js";

describe("retryWithBackoff (EN-059)", () => {
  it("returns the result immediately on first-attempt success", async () => {
    const fn = vi.fn(async () => "ok");
    const result = await retryWithBackoff(fn, { maxAttempts: 3, baseDelayMs: 1 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on availability errors and succeeds once the underlying call recovers", async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new ProviderAvailabilityError("503", 503);
      return "recovered";
    });
    const result = await retryWithBackoff(fn, { maxAttempts: 3, baseDelayMs: 1 });
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws after exhausting all attempts", async () => {
    const fn = vi.fn(async () => {
      throw new ProviderAvailabilityError("still down", 503);
    });
    await expect(retryWithBackoff(fn, { maxAttempts: 3, baseDelayMs: 1 })).rejects.toThrow("still down");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("never retries a ClientRequestError — fails fast on the first attempt", async () => {
    const fn = vi.fn(async () => {
      throw new ClientRequestError("400 malformed", 400);
    });
    await expect(retryWithBackoff(fn, { maxAttempts: 5, baseDelayMs: 1 })).rejects.toThrow(ClientRequestError);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
