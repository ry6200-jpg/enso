import { describe, it } from "vitest";

/**
 * LIVE suite scaffold (EN-090/091). Phase 1 makes no network calls — there
 * is no chat, no provider adapter, no real extractor yet — so this file is
 * intentionally empty of runnable tests. It exists now, as its own
 * `*.live.test.ts` file (never a `.skipIf` wrapper around a FAST test —
 * that pattern is how skipped tests drift invisibly from 16 to 37), so that
 * `npm run test:live` has a real place to grow into once Section 9's
 * provider adapters exist.
 */
describe.todo("live extraction (no network calls exist yet in Phase 1)", () => {
  it.todo("classifies and extracts against a real provider, once one exists");
});
