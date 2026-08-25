import { describe, expect, it } from "vitest";
import { withTimeout } from "../app/lib/firebaseClient.js";

describe("withTimeout (stale-tab investigation fix — the token-path hang guard)", () => {
  it("rejects, rather than resolving a fallback, when the wrapped promise never settles within the bound", async () => {
    const neverSettles = new Promise<string>(() => {});
    await expect(withTimeout(neverSettles, 20, "timed out waiting for a fresh ID token")).rejects.toThrow("timed out waiting for a fresh ID token");
  });

  it("resolves with the real value when the wrapped promise settles first", async () => {
    const fast = new Promise<string>((resolve) => setTimeout(() => resolve("a-real-token"), 5));
    await expect(withTimeout(fast, 50, "timed out")).resolves.toBe("a-real-token");
  });

  it("propagates the wrapped promise's own rejection unchanged when it rejects before the bound", async () => {
    const fails = new Promise<string>((_resolve, reject) => setTimeout(() => reject(new Error("real getIdToken failure")), 5));
    await expect(withTimeout(fails, 50, "timed out")).rejects.toThrow("real getIdToken failure");
  });
});
