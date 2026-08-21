/**
 * EN-083's fallback semantics, exactly: 4xx (malformed request) never burns
 * the fallback — it's a client-side bug, retrying identically on another
 * provider can't fix it (the "who is Sarah?" lesson: both tiers correctly
 * rejected the same malformed request). 5xx/timeouts do fall back.
 *
 * 429 is the one deliberate exception to "4xx = client error": both
 * providers' own docs (verified live, EN-082) describe 429 as a transient
 * rate/availability signal with documented backoff guidance, not a
 * malformed-request signal — so it's classified as an availability error.
 */
export class ClientRequestError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status: number | undefined) {
    super(message);
    this.name = "ClientRequestError";
    this.status = status;
  }
}

export class ProviderAvailabilityError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status: number | undefined) {
    super(message);
    this.name = "ProviderAvailabilityError";
    this.status = status;
  }
}

/** Both failed — carries both underlying errors for diagnostics/logging. */
export class BothTiersFailedError extends Error {
  constructor(
    readonly primaryError: Error,
    readonly fallbackError: Error
  ) {
    super(`Both provider tiers failed. Primary: ${primaryError.message}. Fallback: ${fallbackError.message}`);
    this.name = "BothTiersFailedError";
  }
}

/** Classifies a raw thrown error/status into EN-083's two buckets. */
export function classifyProviderError(err: unknown): ClientRequestError | ProviderAvailabilityError {
  const status = extractStatus(err);
  const message = err instanceof Error ? err.message : String(err);

  if (status === undefined) {
    // No HTTP status at all (network error, timeout, DNS failure, abort) —
    // definitionally an availability problem, not a malformed request.
    return new ProviderAvailabilityError(message, undefined);
  }
  if (status === 429 || status >= 500) {
    return new ProviderAvailabilityError(message, status);
  }
  if (status >= 400) {
    return new ClientRequestError(message, status);
  }
  // Shouldn't happen (2xx/3xx don't throw), but don't silently swallow it.
  return new ProviderAvailabilityError(message, status);
}

function extractStatus(err: unknown): number | undefined {
  if (err && typeof err === "object") {
    const anyErr = err as { status?: unknown; code?: unknown; response?: { status?: unknown } };
    if (typeof anyErr.status === "number") return anyErr.status;
    if (typeof anyErr.response?.status === "number") return anyErr.response.status;
    // @google/genai wraps HTTP errors with a numeric `code` matching the status.
    if (typeof anyErr.code === "number") return anyErr.code;
  }
  return undefined;
}
