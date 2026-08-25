/**
 * Mints a real, usable Firebase ID token for a given UID, entirely from
 * the terminal — no browser, no DevTools. Needed because this app's only
 * sign-in path is Google OAuth (signInWithPopup, app/lib/firebaseClient.ts)
 * with no email/password fallback, and DevTools-based token extraction
 * (Application tab -> IndexedDB -> stsTokenManager) doesn't work on every
 * device (confirmed live: a Chromebook without that access). This is the
 * third time this exact need came up in one session; re-deriving it each
 * round wasted a turn, so it lives here now.
 *
 * Mechanism: uses the SAME Firebase Admin service-account credential
 * lib/requireUser.ts's real verifier already trusts (FIREBASE_SERVICE_ACCOUNT_JSON)
 * to mint a short-lived custom token for the given uid (Admin SDK,
 * createCustomToken — a standard, first-class Firebase Admin operation,
 * not a workaround), then exchanges that custom token for a real ID
 * token via the Identity Toolkit REST API's signInWithCustomToken
 * endpoint, using NEXT_PUBLIC_FIREBASE_API_KEY (already documented
 * elsewhere in this project as public-by-design, never a secret — see
 * firebaseClient.ts's own header comment). Neither credential is
 * hardcoded here; both are read from the environment at runtime, same
 * discipline as every other script/route in this project.
 *
 * The resulting ID token is a REAL, sensitive bearer credential for
 * whatever uid you pass in — treat it exactly like a password for that
 * account's session (don't paste it anywhere public, don't commit it,
 * let it expire on its own — Firebase ID tokens are short-lived, ~1
 * hour). This script mints tokens; it holds no allowlist or admin logic
 * of its own — whether the resulting token can actually reach an
 * admin-only route is still decided entirely server-side (ADMIN_EMAILS,
 * lib/requireUser.ts), exactly as it would be for a token obtained any
 * other way.
 *
 * Usage: node --env-file=.env --import tsx scripts/mintAdminIdToken.ts <uid>
 * (or `npm run mint-token -- <uid>`)
 */
import { cert, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Run with --env-file=.env (see the npm script) or export it first.`);
  return value;
}

async function main(): Promise<void> {
  const uid = process.argv[2];
  if (!uid) {
    console.error("usage: node --env-file=.env --import tsx scripts/mintAdminIdToken.ts <uid>");
    process.exit(1);
  }

  const serviceAccount = JSON.parse(requireEnv("FIREBASE_SERVICE_ACCOUNT_JSON")) as Record<string, string>;
  initializeApp({ credential: cert(serviceAccount) });

  const customToken = await getAuth().createCustomToken(uid);

  const apiKey = requireEnv("NEXT_PUBLIC_FIREBASE_API_KEY");
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: customToken, returnSecureToken: true })
  });
  const json = (await res.json()) as { idToken?: string; error?: unknown };
  if (!res.ok || !json.idToken) {
    console.error("Exchange failed:", JSON.stringify(json));
    process.exit(1);
  }
  console.log(json.idToken);
}

void main();
