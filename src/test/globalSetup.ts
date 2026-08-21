import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Vitest global setup. Creates a fresh, isolated root directory for all
 * per-file test databases and points ENSO_TEST_DB_ROOT at it, so
 * src/test/dbPath.ts never has to guess or fall back to a real path
 * (EN-091). Torn down after the run.
 */
export async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enso-test-db-"));
  process.env.ENSO_TEST_DB_ROOT = root;
  return async () => {
    fs.rmSync(root, { recursive: true, force: true });
  };
}
