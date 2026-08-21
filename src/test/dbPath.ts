import { randomUUID } from "node:crypto";
import path from "node:path";

/**
 * Resolves an isolated, per-test-file SQLite directory. Never falls back to a
 * real database path (EN-091): if the test DB root is unset, or the caller
 * fails to identify itself, this throws instead of guessing.
 */
export function resolveTestDbDir(testFileHint: string | undefined | null): string {
  const root = process.env.ENSO_TEST_DB_ROOT;
  if (!root || root.trim() === "") {
    throw new Error(
      "ENSO_TEST_DB_ROOT is not set. Refusing to resolve a test database path — " +
        "this would otherwise risk falling back to a real database path (EN-091). " +
        "Run tests through `npm test` / `npm run test:live`, which set this via globalSetup."
    );
  }
  if (!testFileHint || testFileHint.trim() === "") {
    throw new Error(
      "Test DB path misresolved: no test file hint was provided. Each test file must pass " +
        "a stable identifier (e.g. import.meta.url) so its database is isolated from others."
    );
  }

  const workerId = process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? "0";
  const safeName = testFileHint
    .replace(/^file:\/\//, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(-120);

  return path.join(root, `${safeName}__w${workerId}`);
}

/**
 * Convenience for tests: a fresh, uniquely-named database path inside this
 * test file's isolated directory. The directory groups all of one file's
 * databases (so files can run in parallel without collisions); the unique
 * filename keeps individual tests within a file from seeing each other's data.
 */
export function freshTestDbPath(testFileHint: string, name: string): string {
  return path.join(resolveTestDbDir(testFileHint), `${name}-${randomUUID()}.db`);
}
