import { describe, expect, it } from "vitest";
import { episodeMode, EpisodeModeNotImplementedError } from "../src/retrieval/episodeMode.js";

describe("episodeMode (EN-037, interface stub only — clustering is Phase 8.5)", () => {
  it("throws EpisodeModeNotImplementedError rather than silently returning an empty/fake result", () => {
    expect(() => episodeMode("some-user", "some-episode")).toThrow(EpisodeModeNotImplementedError);
  });

  it("the error message clearly says why and when, not just 'not implemented'", () => {
    try {
      episodeMode("u", "e");
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as Error).message).toMatch(/Phase 8\.5/);
      expect((err as Error).message).toMatch(/EN-037/);
    }
  });
});
