import { beforeEach, describe, expect, it } from "vitest";
import { createCachedExtractor, ExtractionCache } from "../src/extraction/cache.js";
import { STUB_EXTRACTOR_VERSION, STUB_MODEL_ID, stubExtract } from "../src/extraction/stubExtractor.js";
import { freshTestDbPath } from "../src/test/dbPath.js";

let cache: ExtractionCache;

beforeEach(() => {
  cache = new ExtractionCache(freshTestDbPath(import.meta.url, "cache"));
});

describe("ExtractionCache (EN-056)", () => {
  it("misses on first lookup, hits on second, for the same (content, version, model)", () => {
    let rawCalls = 0;
    const { extract, stats } = createCachedExtractor(cache, STUB_EXTRACTOR_VERSION, STUB_MODEL_ID, (text) => {
      rawCalls++;
      return stubExtract(text);
    });

    const a = extract("Sarah called.");
    const b = extract("Sarah called.");

    expect(rawCalls).toBe(1); // second call was a cache hit, raw extractor not invoked again
    expect(stats).toEqual({ hits: 1, misses: 1 });
    expect(a).toEqual(b);
  });

  it("misses separately for different content, extractor_version, or model id", () => {
    const { extract: extractV1, stats: statsV1 } = createCachedExtractor(cache, "stub-v1", "stub-model", stubExtract);
    const { extract: extractV2, stats: statsV2 } = createCachedExtractor(cache, "stub-v2", "stub-model", stubExtract);

    extractV1("Sarah called.");
    extractV2("Sarah called."); // same content, different extractor_version -> miss, not a hit

    expect(statsV1.misses).toBe(1);
    expect(statsV2.misses).toBe(1);
    expect(cache.size()).toBe(2);
  });

  it("persists across separate ExtractionCache instances pointed at the same file — durable, not in-memory", () => {
    const dbPath = freshTestDbPath(import.meta.url, "durable-cache");
    let rawCalls = 0;
    const firstHandle = new ExtractionCache(dbPath);
    const { extract: extractFirst } = createCachedExtractor(firstHandle, STUB_EXTRACTOR_VERSION, STUB_MODEL_ID, (text) => {
      rawCalls++;
      return stubExtract(text);
    });
    extractFirst("Lunch with Sarah.");
    firstHandle.close();

    const secondHandle = new ExtractionCache(dbPath);
    const { extract: extractSecond } = createCachedExtractor(secondHandle, STUB_EXTRACTOR_VERSION, STUB_MODEL_ID, (text) => {
      rawCalls++;
      return stubExtract(text);
    });
    extractSecond("Lunch with Sarah.");

    expect(rawCalls).toBe(1); // the second handle saw the first handle's cached entry on disk
  });
});

// Note (EN-054/056 v1.5): rebuild no longer accepts an extractor function at
// all — it only reads recorded extraction_completed payloads, and calls no
// provider. The cache's role moving forward is bounding REPROCESS cost (a
// deliberate, versioned re-extraction operation), which is not built this
// phase. A prior test here proved the cache prevented re-extraction across
// two rebuild calls; that scenario no longer exists now that rebuild has no
// extraction step to cache in the first place.
