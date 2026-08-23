import { describe, expect, it } from "vitest";
import { extractBearerToken, ForbiddenError, getVerifiedUserId, isEmailAllowed, UnauthenticatedError, type TokenVerifier } from "../src/auth/verifyRequest.js";

function requestWithAuthHeader(header: string | null): Request {
  const headers = new Headers();
  if (header !== null) headers.set("authorization", header);
  return new Request("http://localhost/api/test", { headers });
}

describe("extractBearerToken", () => {
  it("extracts the token from a well-formed Bearer header", () => {
    expect(extractBearerToken(requestWithAuthHeader("Bearer abc.def.ghi"))).toBe("abc.def.ghi");
  });

  it("returns null when there's no Authorization header at all", () => {
    expect(extractBearerToken(requestWithAuthHeader(null))).toBeNull();
  });

  it("returns null for a non-Bearer scheme", () => {
    expect(extractBearerToken(requestWithAuthHeader("Basic dXNlcjpwYXNz"))).toBeNull();
  });

  it("returns null for a Bearer header with no token", () => {
    expect(extractBearerToken(requestWithAuthHeader("Bearer "))).toBeNull();
  });
});

describe("isEmailAllowed", () => {
  const allowlist = ["Alice@Example.com", "bob@example.com"];

  it("matches case-insensitively", () => {
    expect(isEmailAllowed("alice@example.com", allowlist)).toBe(true);
    expect(isEmailAllowed("ALICE@EXAMPLE.COM", allowlist)).toBe(true);
  });

  it("rejects an email not on the list", () => {
    expect(isEmailAllowed("eve@example.com", allowlist)).toBe(false);
  });

  it("rejects a null email outright", () => {
    expect(isEmailAllowed(null, allowlist)).toBe(false);
  });
});

describe("getVerifiedUserId — fails loudly, never defaults to any user (item 1 requirement)", () => {
  const alwaysVerifies: TokenVerifier = async (token) => (token === "good-token" ? { uid: "uid-123", email: "alice@example.com" } : null);
  const allowlist = ["alice@example.com"];

  it("no Authorization header at all -> throws UnauthenticatedError, never a default identity", async () => {
    await expect(getVerifiedUserId(requestWithAuthHeader(null), alwaysVerifies, allowlist)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it("a present but invalid/expired/malformed token -> throws UnauthenticatedError", async () => {
    await expect(getVerifiedUserId(requestWithAuthHeader("Bearer garbage"), alwaysVerifies, allowlist)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it("a valid token but an email NOT on the allowlist -> throws ForbiddenError, never falls through to any uid", async () => {
    const notAllowlisted: TokenVerifier = async () => ({ uid: "uid-999", email: "stranger@example.com" });
    await expect(getVerifiedUserId(requestWithAuthHeader("Bearer good-token"), notAllowlisted, allowlist)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("a valid token with an allowlisted email -> resolves to the UID, not the email", async () => {
    const uid = await getVerifiedUserId(requestWithAuthHeader("Bearer good-token"), alwaysVerifies, allowlist);
    expect(uid).toBe("uid-123");
    expect(uid).not.toContain("@");
  });

  it("the verifier is never even called when there's no token — no wasted/ambiguous verification attempt", async () => {
    let called = false;
    const trackingVerifier: TokenVerifier = async () => {
      called = true;
      return null;
    };
    await expect(getVerifiedUserId(requestWithAuthHeader(null), trackingVerifier, allowlist)).rejects.toThrow();
    expect(called).toBe(false);
  });
});
