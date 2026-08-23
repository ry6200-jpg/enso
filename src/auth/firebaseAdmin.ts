import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import type { TokenVerifier, VerifiedToken } from "./verifyRequest.js";

/**
 * The real production TokenVerifier (see verifyRequest.ts for why this is
 * deliberately kept thin and untested-directly, same pattern as
 * openaiAdapter.ts/geminiAdapter.ts). Node-runtime only, same constraint
 * as lib/serverPipeline.ts — never import from a client component.
 *
 * Credentials: a Firebase service account, read from
 * FIREBASE_SERVICE_ACCOUNT_JSON (the full JSON key file's contents, as a
 * single-line env var) — never a file path baked into source, matching
 * this project's existing .env-only-secrets discipline (see
 * requireEnv/GOOGLE_MAPS_API_KEY in serverPipeline.ts for the same
 * pattern).
 */
let app: App | undefined;

function getFirebaseAdminApp(): App {
  if (app) return app;
  const existing = getApps();
  if (existing.length > 0) {
    app = existing[0]!;
    return app;
  }
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not set. Add it to .env before starting the web app.");
  const serviceAccount = JSON.parse(raw) as Record<string, string>;
  app = initializeApp({ credential: cert(serviceAccount) });
  return app;
}

export const verifyFirebaseIdToken: TokenVerifier = async (idToken: string): Promise<VerifiedToken | null> => {
  try {
    const decoded = await getAuth(getFirebaseAdminApp()).verifyIdToken(idToken);
    return { uid: decoded.uid, email: decoded.email ?? null };
  } catch {
    // Expired, malformed, revoked, wrong-project — all collapse to "not verified."
    // getVerifiedUserId (verifyRequest.ts) is the one place that turns this into a thrown, fail-loud error.
    return null;
  }
};
