import { beforeEach, describe, expect, it } from "vitest";
import { ExtractionCache } from "../src/extraction/cache.js";
import { createCachedRouter } from "../src/extraction/cachedRouter.js";
import type { ExtractionRouter } from "../src/providers/router.js";
import { freshTestDbPath } from "../src/test/dbPath.js";

let cache: ExtractionCache;

beforeEach(() => {
  cache = new ExtractionCache(freshTestDbPath(import.meta.url, "cache"));
});

describe("createCachedRouter (EN-056, real-provider reuse)", () => {
  it("misses then hits for the same request text, never calling the underlying router twice", async () => {
    let calls = 0;
    const fakeRouter: ExtractionRouter = {
      extract: async () => {
        calls++;
        return { provider: "openai", model: "gpt-5.6-terra", taxonomy: { entities: [], statedFeelings: [], episodeMarkers: [], structuralAtoms: [], socialBonds: [], attributes: [] }, usage: { inputTokens: 5, outputTokens: 5, cachedInputTokens: 0 } };
      }
    };
    const { router: cachedRouter, stats } = createCachedRouter(cache, fakeRouter, "message-v1");

    await cachedRouter.extract({ kind: "message", text: "Same text twice." });
    await cachedRouter.extract({ kind: "message", text: "Same text twice." });

    expect(calls).toBe(1);
    expect(stats).toEqual({ hits: 1, misses: 1 });
  });

  it("misses separately for different extractor_version, even with identical text", async () => {
    const fakeRouter: ExtractionRouter = {
      extract: async () => ({ provider: "gemini", model: "gemini-3.7-flash", taxonomy: { entities: [], statedFeelings: [], episodeMarkers: [], structuralAtoms: [], socialBonds: [], attributes: [] }, usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 } })
    };
    const a = createCachedRouter(cache, fakeRouter, "message-v1");
    const b = createCachedRouter(cache, fakeRouter, "message-v2");

    await a.router.extract({ kind: "message", text: "same text" });
    await b.router.extract({ kind: "message", text: "same text" });

    expect(a.stats.misses).toBe(1);
    expect(b.stats.misses).toBe(1);
  });
});
