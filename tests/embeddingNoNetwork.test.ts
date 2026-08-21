import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { beforeAll, describe, expect, it } from "vitest";
import { pipeline, env as transformersEnv } from "@huggingface/transformers";
import { configureLocalOnlyEmbeddings, createEmbedder, DEFAULT_MODEL_CACHE_DIR, EMBEDDING_DIMENSIONS, EMBEDDING_MODEL_ID } from "../src/embeddings/embedder.js";
import { freshTestDbPath } from "../src/test/dbPath.js";

beforeAll(() => {
  if (!fs.existsSync(DEFAULT_MODEL_CACHE_DIR)) {
    throw new Error(
      `Embedding model cache not found at ${DEFAULT_MODEL_CACHE_DIR}. This is a required local setup ` +
        `artifact (like node_modules) — run \`npx tsx scripts/warmEmbeddingModelCache.ts\` once before running tests. ` +
        `Failing loudly rather than silently falling back to a network fetch (EN-094).`
    );
  }
  configureLocalOnlyEmbeddings();
});

/**
 * Proves EN-094's hard constraint mechanically, not just by inspection:
 * intercepts every plausible outbound network primitive in Node
 * (http.request/get, https.request/get, global.fetch) during an actual
 * embed() call and fails the test if any of them is ever invoked.
 */
async function embedWithNetworkGuard(fn: () => Promise<unknown>): Promise<{ networkCallsAttempted: string[] }> {
  const attempted: string[] = [];

  const originalHttpRequest = http.request;
  const originalHttpGet = http.get;
  const originalHttpsRequest = https.request;
  const originalHttpsGet = https.get;
  const originalFetch = globalThis.fetch;

  function guard(name: string): never {
    attempted.push(name);
    throw new Error(`Network access attempted during embedding (${name}) — this must never happen (EN-094).`);
  }

  // Deliberately replacing with a guard that throws, not a real implementation.
  http.request = (() => guard("http.request")) as typeof http.request;
  http.get = (() => guard("http.get")) as typeof http.get;
  https.request = (() => guard("https.request")) as typeof https.request;
  https.get = (() => guard("https.get")) as typeof https.get;
  globalThis.fetch = (() => guard("fetch")) as typeof fetch;

  try {
    await fn();
  } finally {
    http.request = originalHttpRequest;
    http.get = originalHttpGet;
    https.request = originalHttpsRequest;
    https.get = originalHttpsGet;
    globalThis.fetch = originalFetch;
  }

  return { networkCallsAttempted: attempted };
}

describe("local embeddings make zero network calls (EN-035/EN-094 hard constraint)", () => {
  it("computes an embedding with no http/https/fetch call attempted", async () => {
    const embedder = await createEmbedder();

    const { networkCallsAttempted } = await embedWithNetworkGuard(async () => {
      const vector = embedder.embed("A week at the cabin in Tahoe.");
      await vector;
    });

    expect(networkCallsAttempted).toEqual([]);
  });

  it("produces a normalized 384-dimensional vector", async () => {
    const embedder = await createEmbedder();
    const vector = await embedder.embed("Test sentence.");
    expect(vector.length).toBe(EMBEDDING_DIMENSIONS);
    expect(embedder.dimensions).toBe(EMBEDDING_DIMENSIONS);
    // normalize: true means unit length
    const magnitude = Math.sqrt(Array.from(vector).reduce((sum, v) => sum + v * v, 0));
    expect(magnitude).toBeCloseTo(1.0, 3);
  });

  it("is deterministic for a fixed model — the same text always produces the same vector (required for rebuild)", async () => {
    const embedder = await createEmbedder();
    const a = await embedder.embed("Deterministic embedding check.");
    const b = await embedder.embed("Deterministic embedding check.");
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("EN-091-style fail-loud proof: with the model NOT cached at a given path and remote disabled, loading throws instead of silently fetching", async () => {
    const emptyCacheDir = freshTestDbPath(import.meta.url, "empty-model-cache");
    const savedCacheDir = transformersEnv.cacheDir;
    const savedAllowRemote = transformersEnv.allowRemoteModels;
    transformersEnv.cacheDir = emptyCacheDir;
    transformersEnv.allowRemoteModels = false;

    try {
      await expect(pipeline("feature-extraction", EMBEDDING_MODEL_ID)).rejects.toThrow(/allowRemoteModels|local_files_only/);
    } finally {
      transformersEnv.cacheDir = savedCacheDir;
      transformersEnv.allowRemoteModels = savedAllowRemote;
    }
  });
});
