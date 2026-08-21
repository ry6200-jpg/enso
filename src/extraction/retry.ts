import { ClientRequestError } from "../providers/errors.js";

export interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = { maxAttempts: 3, baseDelayMs: 300 };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry with exponential backoff (EN-059), wrapping a single logical
 * extraction attempt — which, via the router, already includes EN-081/083's
 * one-shot tier1-then-tier2 fallback. This loop retries the *whole*
 * primary-then-fallback attempt, for when both tiers are transiently down
 * at once. A ClientRequestError is never retried at this layer either — the
 * request is malformed, and repeating it identically (even after a delay,
 * even on both tiers again) can't fix that.
 */
export async function retryWithBackoff<T>(fn: () => Promise<T>, config: RetryConfig = DEFAULT_RETRY_CONFIG): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (err instanceof ClientRequestError) {
        throw err;
      }
      if (attempt < config.maxAttempts) {
        await sleep(config.baseDelayMs * 2 ** (attempt - 1));
      }
    }
  }

  throw lastError;
}
