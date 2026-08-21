import { beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/events/eventLog.js";
import { createCachedExtractor, ExtractionCache } from "../src/extraction/cache.js";
import { STUB_EXTRACTOR_VERSION, STUB_MODEL_ID, stubExtract } from "../src/extraction/stubExtractor.js";
import { ProjectionsDb } from "../src/projections/db.js";
import { rebuildProjections } from "../src/projections/rebuild.js";
import { compareStructural, snapshotFromEntityRows } from "../src/comparator/structuralEquivalence.js";
import { freshTestDbPath } from "../src/test/dbPath.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";

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

  it("survives across independent rebuilds — the cache is not a projection", () => {
    const eventLog = new EventLog(freshTestDbPath(import.meta.url, "events"));
    const projections = new ProjectionsDb(freshTestDbPath(import.meta.url, "projections"));

    const msg = eventLog.append({
      type: "message_sent",
      actor: "user",
      payload: { text: "Lunch with Sarah." },
      userId: PRIMARY_USER_ID
    });
    eventLog.append({
      type: "extraction_completed",
      actor: "system",
      payload: { sourceEventId: msg.id, extractorVersion: STUB_EXTRACTOR_VERSION, modelId: STUB_MODEL_ID, entities: [], relationships: [], dates: [] },
      userId: PRIMARY_USER_ID
    });

    let rawCalls = 0;
    const { extract } = createCachedExtractor(cache, STUB_EXTRACTOR_VERSION, STUB_MODEL_ID, (text) => {
      rawCalls++;
      return stubExtract(text);
    });

    const events = eventLog.listForUser(PRIMARY_USER_ID);

    rebuildProjections(events, projections, PRIMARY_USER_ID, extract);
    expect(rawCalls).toBe(1); // first rebuild: cache miss, extractor actually ran

    const projectionsRebuilt = new ProjectionsDb(freshTestDbPath(import.meta.url, "projections-2"));
    rebuildProjections(events, projectionsRebuilt, PRIMARY_USER_ID, extract);
    expect(rawCalls).toBe(1); // second rebuild reused the cache — the raw extractor did NOT run again

    const before = snapshotFromEntityRows(projections.listEntities(PRIMARY_USER_ID));
    const after = snapshotFromEntityRows(projectionsRebuilt.listEntities(PRIMARY_USER_ID));
    expect(compareStructural(before, after)).toEqual({ equivalent: true, differences: [] });
  });
});
