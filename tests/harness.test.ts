import { describe, expect, it } from "vitest";
import { resolveTestDbDir } from "../src/test/dbPath.js";

/**
 * EN-091: the test suite must fail loudly — never fall back to a real
 * database path — if the test DB path is unset or misresolved. This test
 * proves that failure mode actually fires, rather than trusting it by
 * inspection.
 */
describe("test harness fail-loud guarantee (EN-091)", () => {
  it("throws instead of resolving a path when ENSO_TEST_DB_ROOT is unset", () => {
    const saved = process.env.ENSO_TEST_DB_ROOT;
    delete process.env.ENSO_TEST_DB_ROOT;
    try {
      expect(() => resolveTestDbDir(import.meta.url)).toThrow(/ENSO_TEST_DB_ROOT is not set/);
    } finally {
      if (saved !== undefined) process.env.ENSO_TEST_DB_ROOT = saved;
    }
  });

  it("throws instead of resolving a path when the caller gives no file hint", () => {
    expect(() => resolveTestDbDir("")).toThrow(/misresolved/);
    expect(() => resolveTestDbDir(undefined)).toThrow(/misresolved/);
  });

  it("resolves distinct directories for distinct test file hints (per-file isolation, EN-091)", () => {
    const a = resolveTestDbDir("file:///repo/tests/a.test.ts");
    const b = resolveTestDbDir("file:///repo/tests/b.test.ts");
    expect(a).not.toEqual(b);
  });
});
