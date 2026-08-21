import path from "node:path";
import { env, pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

/**
 * Local embeddings (EN-035/EN-094): sqlite-vec for storage/search, a
 * locally-run ONNX model for the vectors themselves — no embeddings API,
 * ever. Model choice: Xenova/all-MiniLM-L6-v2 — 384 dimensions,
 * Apache-2.0, ~22M parameters, the standard small sentence-embedding
 * model for exactly this kind of single-user local corpus (verified
 * against the model's Hugging Face card and transformers.js docs on
 * 2026-08-21, not assumed from memory). Chosen over larger alternatives
 * (all-mpnet-base-v2 at 768 dims, bge-base-en-v1.5) because Enso's own
 * scale assumption (EN-001: single user, "possibly a small group of
 * testers") doesn't need — and shouldn't pay the CPU-inference cost of —
 * a bigger model; MiniLM already handles the retrieval quality bar this
 * corpus size needs (see the chunking-comparison results in the Phase 4
 * report for measured evidence on this specific corpus, not a generic
 * benchmark claim).
 *
 * Known tradeoff, disclosed rather than hidden: @huggingface/transformers
 * pulls in onnxruntime-node (a transitive dependency on a vulnerable
 * adm-zip — GHSA-xcpc-8h2w-3j85, no fix available) and sharp (transitive
 * libvips CVEs, no fix available). Neither vulnerable code path is
 * exercised by this project's actual usage: adm-zip's crafted-ZIP DoS is
 * an onnxruntime-node install-time concern (fetching prebuilt binaries
 * from the trusted npm/GitHub release infrastructure, not arbitrary
 * attacker-supplied ZIPs at runtime), and sharp is required by the
 * package for its (unused here) image-model support — Enso only ever
 * calls the `feature-extraction` pipeline on text (messages, document
 * full text, image DESCRIPTIONS, which are already text). Flagged here
 * rather than swept under the rug; re-evaluate if either package ships a
 * fix, or if a lighter-weight ONNX runtime binding becomes available.
 */
export const EMBEDDING_MODEL_ID = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_DIMENSIONS = 384;

export const DEFAULT_MODEL_CACHE_DIR = path.join(process.cwd(), ".cache", "embedding-model");

export interface Embedder {
  embed(text: string): Promise<Float32Array>;
  readonly modelId: string;
  readonly dimensions: number;
}

/**
 * Locks the runtime to local-only model resolution: `allowRemoteModels:
 * false` makes transformers.js throw immediately if the model isn't
 * already cached at `cacheDir`, rather than silently reaching the
 * network — this is the hard constraint (EN-094) enforced structurally,
 * not just by convention. Populating the cache in the first place is a
 * separate, explicitly network-permitted setup step (see
 * scripts/warmEmbeddingModelCache.ts) — analogous to `npm install`, not
 * part of the embedding path itself.
 */
export function configureLocalOnlyEmbeddings(cacheDir: string = DEFAULT_MODEL_CACHE_DIR): void {
  env.cacheDir = cacheDir;
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
}

let cachedPipeline: FeatureExtractionPipeline | undefined;

/**
 * Creates the embedder. Call `configureLocalOnlyEmbeddings` first (once,
 * at process startup) — this function doesn't do it implicitly, so a
 * caller can't accidentally end up in remote-allowed mode by forgetting
 * an import order.
 */
export async function createEmbedder(): Promise<Embedder> {
  if (!cachedPipeline) {
    cachedPipeline = (await pipeline("feature-extraction", EMBEDDING_MODEL_ID)) as FeatureExtractionPipeline;
  }
  const extractor = cachedPipeline;

  return {
    modelId: EMBEDDING_MODEL_ID,
    dimensions: EMBEDDING_DIMENSIONS,
    async embed(text: string): Promise<Float32Array> {
      const output = await extractor(text, { pooling: "mean", normalize: true });
      return new Float32Array(output.data as Float32Array);
    }
  };
}
