import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Per-file isolated SQLite databases live under here; each test file
    // computes its own subdirectory (see src/test/dbPath.ts). Parallelism
    // is safe because no two files share a path.
    globalSetup: ["./src/test/globalSetup.ts"],
    fileParallelism: true,
    testTimeout: 10_000
  }
});
