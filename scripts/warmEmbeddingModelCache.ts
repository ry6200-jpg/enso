/**
 * One-time setup: downloads and caches the local embedding model
 * (EN-035/EN-094). This is the ONLY place network access to fetch model
 * weights is permitted — analogous to `npm install`, not part of the
 * embedding path itself. After this runs once, embedding computation
 * never touches the network (see src/embeddings/embedder.ts and
 * tests/embeddingNoNetwork.test.ts, which proves it).
 *
 * Usage: npx tsx scripts/warmEmbeddingModelCache.ts
 */
import { env, pipeline } from "@huggingface/transformers";
import { DEFAULT_MODEL_CACHE_DIR, EMBEDDING_MODEL_ID } from "../src/embeddings/embedder.js";

async function main(): Promise<void> {
  env.cacheDir = DEFAULT_MODEL_CACHE_DIR;
  env.allowRemoteModels = true; // explicitly permitted here, and only here

  console.log(`Downloading and caching ${EMBEDDING_MODEL_ID} to ${DEFAULT_MODEL_CACHE_DIR} ...`);
  await pipeline("feature-extraction", EMBEDDING_MODEL_ID);
  console.log("Done. Embedding computation from here on never touches the network.");
}

main().catch((err) => {
  console.error("Failed to warm the embedding model cache:", err);
  process.exit(1);
});
