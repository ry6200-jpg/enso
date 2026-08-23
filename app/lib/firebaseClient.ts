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
 */
export function getCurrentIdToken(): Promise<string | null> {
  const auth = getAuth(getFirebaseApp());
  const user = auth.currentUser;
  if (!user) return Promise.resolve(null);
  return user.getIdToken();
}

/** Every authenticated fetch in this app goes through this — one place to attach the Bearer token, never duplicated per call site. Throws if signed out; callers only ever use this after confirming a user is present. */
export async function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const token = await getCurrentIdToken();
  if (!token) throw new Error("authFetch called with no signed-in user.");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}
