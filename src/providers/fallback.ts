import { ClientRequestError } from "./errors.js";
import { BothTiersFailedError } from "./errors.js";

/**
 * EN-081/083's two-tier fallback pattern, generic over the request/response
 * shape so it backs the taxonomy router, the document-content router, and
 * the image-description router without three copies of the same try/catch.
 * A ClientRequestError from the primary is re-thrown immediately — never
 * burn the fallback on a malformed request (EN-083).
 */
export async function runWithFallback<Req, Res>(
  primary: (req: Req) => Promise<Res>,
  fallback: (req: Req) => Promise<Res>,
  request: Req
): Promise<Res> {
  try {
    return await primary(request);
  } catch (primaryErr) {
    if (primaryErr instanceof ClientRequestError) {
      throw primaryErr;
    }
    try {
      return await fallback(request);
    } catch (fallbackErr) {
      const p = primaryErr instanceof Error ? primaryErr : new Error(String(primaryErr));
      const f = fallbackErr instanceof Error ? fallbackErr : new Error(String(fallbackErr));
      throw new BothTiersFailedError(p, f);
    }
  }
}
