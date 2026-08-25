"use client";

import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut as firebaseSignOut, onIdTokenChanged, type User } from "firebase/auth";

/**
 * Client-side Firebase Auth (Cloud migration prerequisite batch, item 1).
 * Google sign-in only, closed test — the allowlist itself is enforced
 * server-side (every route, via lib/requireUser.ts), never duplicated
 * here: this file never reads or checks an allowlist. The client's own
 * job after sign-in is limited to noticing a 403 from the first real
 * request and signing back out with an honest message — see app/page.tsx.
 *
 * Config values are NEXT_PUBLIC_* (Firebase's own client config is not a
 * secret — see Firebase's own docs; the service account used server-side
 * for verification is the actual secret, and lives only in
 * FIREBASE_SERVICE_ACCOUNT_JSON, never exposed to the client).
 */
function getFirebaseApp(): FirebaseApp {
  const existing = getApps();
  if (existing.length > 0) return existing[0]!;
  return initializeApp({
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID
  });
}

export function signInWithGoogle(): Promise<User> {
  const auth = getAuth(getFirebaseApp());
  return signInWithPopup(auth, new GoogleAuthProvider()).then((result) => result.user);
}

export function signOut(): Promise<void> {
  const auth = getAuth(getFirebaseApp());
  return firebaseSignOut(auth);
}

/**
 * Live-caught: a fresh Chrome profile with no existing session got stuck
 * on "Checking sign-in..." forever — console completely clean, no
 * Firebase errors. Root cause: onIdTokenChanged's FIRST callback only
 * fires once Auth's internal authStateReady() resolves, and because this
 * project's authDomain (a firebaseapp.com host) is a different origin
 * than the app itself, that resolution involves a cross-origin iframe
 * handshake with the authDomain for auth-state sync. If that handshake
 * hangs for any reason (third-party-cookie blocking, a network path
 * issue, anything that stalls without actually failing), the promise
 * simply never resolves — no error to log, just silence, and the app
 * never learns it's signed out.
 *
 * Fix: never let the UI wait indefinitely on one external call it
 * doesn't control. If nothing has fired within AUTH_STATE_TIMEOUT_MS,
 * assume signed-out so a sign-in button always appears — the real
 * listener stays subscribed underneath and still corrects the state
 * (to signed-in, or to a different user) if/when it does eventually
 * report in; this is a fallback, never a replacement for the real event.
 */
const AUTH_STATE_TIMEOUT_MS = 4000;

/**
 * Bounded wait on a promise Firebase's SDK controls but this app doesn't —
 * same shape as AUTH_STATE_TIMEOUT_MS above (never let the UI wait
 * indefinitely on an external call it doesn't control), reused below for
 * getCurrentIdToken's own call to the SDK's getIdToken(), which had no
 * guard at all (stale-tab investigation: this was the actual hang — a tab
 * left open long enough for its cached ID token to need a network refresh,
 * where that refresh call could stall forever with no timeout, no error,
 * and nothing to log). REJECTS on timeout, deliberately never resolves a
 * fallback value: a silent empty resolve here would just move the hang
 * one level up instead of fixing it — callers need a real rejection to
 * reach their existing .catch() branches and become a visible failure
 * state, not another value that looks like success.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, timeoutMessage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(timeoutMessage)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export function watchAuthState(onChange: (user: User | null) => void): () => void {
  const auth = getAuth(getFirebaseApp());
  let fired = false;
  const unsubscribe = onIdTokenChanged(auth, (user) => {
    fired = true;
    onChange(user);
  });
  const timer = setTimeout(() => {
    if (!fired) onChange(null);
  }, AUTH_STATE_TIMEOUT_MS);
  return () => {
    clearTimeout(timer);
    unsubscribe();
  };
}

/**
 * The current user's fresh ID token, or null if signed out. Firebase's
 * client SDK handles refresh internally — this always returns a
 * currently-valid token, never a cached-and-possibly-expired one, per the
 * SDK's own getIdToken() contract.
 *
 * Scroll/history/focus/zodiac batch, item 2: real production logs showed
 * genuine 401s on GET /api/history — this request WAS made, with a
 * missing or invalid token, even though the client believed it was
 * signed in. Root cause: this used to read `auth.currentUser` directly
 * and synchronously — but `onIdTokenChanged` firing (which is what sets
 * this page's own `user` React state, see watchAuthState above) does not
 * guarantee `auth.currentUser` is the SDK's own fully-settled snapshot
 * yet, on a cold navigation specifically. watchAuthState's own
 * AUTH_STATE_TIMEOUT_MS comment already documents this exact
 * authDomain's cross-origin iframe handshake as a known source of timing
 * uncertainty; `auth.authStateReady()` is the SDK's own documented
 * primitive for exactly this — "resolves when the initial auth state is
 * settled" — so this now waits on it before ever reading `currentUser`,
 * instead of only reading a callback-delivered `user` object that could
 * be ahead of the SDK's own internal state. Safe against hanging forever
 * the same way the settled onIdTokenChanged callback that got the caller
 * here already proves the "initial auth state" milestone has been
 * reached — this call resolves promptly in that case, not a fresh wait
 * from zero.
 */
export async function getCurrentIdToken(): Promise<string | null> {
  const auth = getAuth(getFirebaseApp());
  await auth.authStateReady();
  const user = auth.currentUser;
  if (!user) return null;
  return withTimeout(user.getIdToken(), AUTH_STATE_TIMEOUT_MS, "Timed out waiting for a fresh ID token — the tab may have been idle too long.");
}

/** Every authenticated fetch in this app goes through this — one place to attach the Bearer token, never duplicated per call site. Throws if signed out; callers only ever use this after confirming a user is present. */
export async function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const token = await getCurrentIdToken();
  if (!token) throw new Error("authFetch called with no signed-in user.");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}
