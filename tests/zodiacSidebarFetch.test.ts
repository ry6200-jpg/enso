import { describe, expect, it } from "vitest";
import { resolveZodiacSidebarResponse } from "../app/lib/zodiacSidebarFetch.js";

describe("resolveZodiacSidebarResponse (stale-tab investigation fix)", () => {
  it("rejects a non-ok response instead of parsing its error body as zodiac data", async () => {
    const fakeResponse = { ok: false, status: 401, json: async () => ({ error: "Token is missing, expired, or invalid." }) };
    await expect(resolveZodiacSidebarResponse(fakeResponse)).rejects.toThrow("401");
  });

  it("a 401 error body would otherwise satisfy ZodiacSidebarData's shape (available undefined -> falsy, rendering as a normal empty state) — must reject rather than silently returning it", async () => {
    const fakeResponse = { ok: false, status: 401, json: async () => ({ error: "Token is missing, expired, or invalid." }) };
    await expect(resolveZodiacSidebarResponse(fakeResponse)).rejects.toBeInstanceOf(Error);
  });

  it("rejects a 403 the same way", async () => {
    const fakeResponse = { ok: false, status: 403, json: async () => ({ error: "This account is not authorized for this closed test." }) };
    await expect(resolveZodiacSidebarResponse(fakeResponse)).rejects.toThrow("403");
  });

  it("parses the body normally for an ok response", async () => {
    const fakeResponse = { ok: true, status: 200, json: async () => ({ available: false }) };
    await expect(resolveZodiacSidebarResponse(fakeResponse)).resolves.toEqual({ available: false });
  });
});
