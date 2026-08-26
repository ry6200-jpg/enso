import { describe, expect, it } from "vitest";
import { classifyDirectoryFetchStatus } from "../app/lib/directoryFetch.js";

describe("classifyDirectoryFetchStatus (EN-110, R71)", () => {
  it("404 is notAdmin — the real server-side gate, never retried", () => {
    expect(classifyDirectoryFetchStatus(404)).toBe("notAdmin");
  });

  it("401 is notAuthenticated — distinct from notAdmin, never a positive admin signal", () => {
    expect(classifyDirectoryFetchStatus(401)).toBe("notAuthenticated");
  });

  it("500 (a storage-lock refusal in practice) is retryable, never notAdmin and never success", () => {
    expect(classifyDirectoryFetchStatus(500)).toBe("retryable");
  });

  it("any other non-2xx status is also retryable, never silently read as admin", () => {
    expect(classifyDirectoryFetchStatus(503)).toBe("retryable");
    expect(classifyDirectoryFetchStatus(0)).toBe("retryable");
  });

  it("2xx is success", () => {
    expect(classifyDirectoryFetchStatus(200)).toBe("success");
    expect(classifyDirectoryFetchStatus(204)).toBe("success");
  });

  it("R71 regression guard: 401 and 500 are NOT the same outcome as success — the original bug read status !== 404 as admin, which is true for both", () => {
    expect(classifyDirectoryFetchStatus(401)).not.toBe("success");
    expect(classifyDirectoryFetchStatus(500)).not.toBe("success");
  });
});
