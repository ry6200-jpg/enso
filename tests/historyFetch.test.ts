import { describe, expect, it } from "vitest";
import { classifyHistoryFetchStatus } from "../app/lib/historyFetch.js";

describe("classifyHistoryFetchStatus (stale-tab investigation fix)", () => {
  it("401 (expired/missing/invalid token) is an auth failure, same as 403", () => {
    expect(classifyHistoryFetchStatus(401)).toBe("authFailure");
  });

  it("403 (valid token, not on the allowlist) is an auth failure", () => {
    expect(classifyHistoryFetchStatus(403)).toBe("authFailure");
  });

  it("a non-2xx, non-auth status is a plain load failure", () => {
    expect(classifyHistoryFetchStatus(500)).toBe("loadFailure");
    expect(classifyHistoryFetchStatus(404)).toBe("loadFailure");
    expect(classifyHistoryFetchStatus(0)).toBe("loadFailure");
  });

  it("2xx is success", () => {
    expect(classifyHistoryFetchStatus(200)).toBe("success");
    expect(classifyHistoryFetchStatus(204)).toBe("success");
  });
});
