import { contentHash } from "./contentHash.js";
import { ExtractionCache, type CacheKey } from "./cache.js";
import type { ExtractionRouter } from "../providers/router.js";
import type { ExtractionRequest, ProviderCallResult } from "../providers/types.js";

export interface CachedRouterStats {
  hits: number;
  misses: number;
}

/**
 * Wraps a real (async, paid) extraction router with the same
 * ExtractionCache table Phase 1 built for the stub extractor (EN-056) —
 * generic now, so a real provider's output is just as cacheable as the
 * stub's was. The cache itself doesn't care whether misses cost nothing
 * (stub) or real money (a live API call); the "prevents re-extraction"
 * guarantee is identical either way, which is the point.
 */
export function createCachedRouter(
  cache: ExtractionCache,
  router: ExtractionRouter,
  extractorVersion: string
): { router: ExtractionRouter; stats: CachedRouterStats } {
  const stats: CachedRouterStats = { hits: 0, misses: 0 };

  const wrapped: ExtractionRouter = {
    extract: async (request: ExtractionRequest): Promise<ProviderCallResult> => {
      const key: CacheKey = {
        contentHash: contentHash(request.text),
        extractorVersion,
        modelId: "router" // caches on the routing decision's outcome, not one fixed model id
      };
      const cached = cache.get<ProviderCallResult>(key);
      if (cached) {
        stats.hits++;
        return cached;
      }
      stats.misses++;
      const result = await router.extract(request);
      cache.put(key, result);
      return result;
    }
  };

  return { router: wrapped, stats };
}
