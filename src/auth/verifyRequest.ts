/**
 * Real user identity (Cloud migration prerequisite batch, item 1). Every
 * API route's identity now comes from a verified Google ID token, never
 * from a client-supplied value — the same "fail loudly, never silently
 * default" discipline CLAUDE.md already requires for the test DB path
 * (EN-091), extended here to user identity itself.
 *
 * This file is the injectable, pure core: token extraction and the
 * allowlist/uid decision, both FAST-testable with a fake TokenVerifier —
 * no real Firebase project, no network call, needed to test the actual
 * decision logic. The real production verifier (wrapping firebase-admin)
 * lives in firebaseAdmin.ts and is never imported here, matching this
 * codebase's existing pattern for provider adapters (openaiAdapter.ts
 * etc.): a thin, obviously-correct wrapper around a vendor SDK, tested via
 * the abstraction it implements, not re-tested itself.
 */

export class UnauthenticatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnauthenticatedError";
  }
}

export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForbiddenError";
  }
}

export interface VerifiedToken {
  /** The Google/Firebase UID — stable identity, keyed on for every data path and every user_id column. Never the email: emails change, the UID doesn't. */
  uid: string;
  /** Used ONLY for the allowlist gate below — never for identity, never for a data path, never stored as user_id anywhere. */
  email: string | null;
}

/** Injectable so FAST tests never need a real Firebase project or a network call — see firebaseAdmin.ts for the real implementation. Returns null for any invalid/expired/malformed token; never throws (the caller is the single place that turns "no valid identity" into a thrown, fail-loud error). */
export type TokenVerifier = (idToken: string) => Promise<VerifiedToken | null>;

/** Pure — parses the `Authorization: Bearer <token>` header. No network, no I/O. Returns null for a missing header, a wrong scheme, or an empty token. */
export function extractBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (!match) return null;
  const token = match[1]!.trim();
  return token.length > 0 ? token : null;
}

/** Pure, case-insensitive membership check against the allowlist — the ONLY place email is ever used for a decision. */
export function isEmailAllowed(email: string | null, allowedEmails: readonly string[]): boolean {
  if (email === null) return false;
  const lower = email.toLowerCase();
  return allowedEmails.some((allowed) => allowed.toLowerCase() === lower);
}

/**
 * The one function every route calls. Fails loudly (throws) rather than
 * ever returning a default/anonymous identity — an unauthenticated or
 * misconfigured request must never silently reach any user's data, the
 * same discipline this project already applies to the test DB path.
 * Returns the verified UID only — callers must never read `.email` back
 * out of this function's result for anything beyond the allowlist check
 * already performed here.
 */
export async function getVerifiedUserId(request: Request, verifier: TokenVerifier, allowedEmails: readonly string[]): Promise<string> {
  const token = extractBearerToken(request);
  if (!token) throw new UnauthenticatedError("No Authorization: Bearer token present.");

  const verified = await verifier(token);
  if (!verified) throw new UnauthenticatedError("Token is missing, expired, or invalid.");

  if (!isEmailAllowed(verified.email, allowedEmails)) {
    throw new ForbiddenError("This account is not on the allowlist for this closed test.");
  }

  return verified.uid;
}
