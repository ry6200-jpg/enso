import { afterEach, describe, expect, it } from "vitest";
import { adminEmails } from "../lib/requireUser.js";

/**
 * Admin-only entity view, part 2: the absent/empty-var case for
 * ADMIN_EMAILS specifically, at the actual env-reading layer (not just
 * the pure getVerifiedAdminUserId logic, already covered in
 * tests/verifyRequest.test.ts — this confirms the real env var name and
 * its real fail-closed parsing behavior).
 */
describe("adminEmails() — ADMIN_EMAILS env var, fail-closed", () => {
  const original = process.env.ADMIN_EMAILS;
  afterEach(() => {
    if (original === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = original;
  });

  it("the absent-var case: returns an empty list (no admin at all), never throws and never defaults to 'everyone'", () => {
    delete process.env.ADMIN_EMAILS;
    expect(adminEmails()).toEqual([]);
  });

  it("an empty-string var also fails closed to an empty list", () => {
    process.env.ADMIN_EMAILS = "";
    expect(adminEmails()).toEqual([]);
  });

  it("a real value is parsed as a comma-separated, trimmed list", () => {
    process.env.ADMIN_EMAILS = " admin1@example.com , admin2@example.com ";
    expect(adminEmails()).toEqual(["admin1@example.com", "admin2@example.com"]);
  });

  it("a single email with no comma still parses to a one-element list", () => {
    process.env.ADMIN_EMAILS = "ry6200@gmail.com";
    expect(adminEmails()).toEqual(["ry6200@gmail.com"]);
  });
});
