import { NextResponse } from "next/server";
import { ForbiddenError, getVerifiedUserId, UnauthenticatedError } from "../src/auth/verifyRequest.js";
import { verifyFirebaseIdToken } from "../src/auth/firebaseAdmin.js";

/**
 * The one call every route makes to get an identity — wraps the pure,
 * FAST-tested core (src/auth/verifyRequest.ts's getVerifiedUserId) with
 * the real production verifier and the allowlist read from env.
 *
 * ALLOWED_EMAILS: comma-separated, configured outside the code (env var,
 * .env locally) — this is a closed test; anyone whose token verifies but
 * whose email isn't on this list is turned away (ForbiddenError). Never
 * hardcoded in source, same discipline as every other secret/config value
 * in this project (see requireEnv in serverPipeline.ts).
 */
function allowedEmails(): string[] {
  const raw = process.env.ALLOWED_EMAILS;
  if (!raw) throw new Error("ALLOWED_EMAILS is not set. Add a comma-separated list to .env before starting the web app.");
  return raw
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
}

export function requireUserId(request: Request): Promise<string> {
  return getVerifiedUserId(request, verifyFirebaseIdToken, allowedEmails());
}

/** Every route's uniform catch: an auth failure becomes 401/403, never a 500 and never a fallthrough to any default identity. */
export function authErrorResponse(err: unknown): Response | null {
  if (err instanceof UnauthenticatedError) return NextResponse.json({ error: err.message }, { status: 401 });
  if (err instanceof ForbiddenError) return NextResponse.json({ error: err.message }, { status: 403 });
  return null;
}
