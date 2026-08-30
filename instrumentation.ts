/**
 * Storage durability batch, PART 3 (EN-125): Next.js's official hook for
 * code that runs once when the server process starts, in every runtime
 * this app actually uses (dev, and the standalone `server.js` Cloud Run
 * runs — see Dockerfile). Registering a SIGTERM handler is the actual
 * fix: with NO handler registered, Node's default disposition for
 * SIGTERM terminates the process immediately, giving an in-flight
 * checkout (mid-download, mid-work, mid-checkpoint-and-upload) no chance
 * to finish — exactly what happened in the deploy-race stale-lock
 * incident this batch investigates (revision 00018 held a checkout, 00019
 * rolled out, SIGTERM arrived, and the old container was gone before
 * checkin could run). Cloud Run gives roughly 10 seconds between SIGTERM
 * and a hard SIGKILL; GRACE_MS below is deliberately under that, leaving
 * margin for this handler's own work and Cloud Run's own scheduling
 * jitter rather than racing the SIGKILL directly.
 *
 * Deliberately does NOT try to force any in-flight `work` (an LLM call in
 * progress, for instance) to wrap up early — there is no safe early-exit
 * point this layer could invent for arbitrary business logic. All it does
 * is hold the process open long enough for requests that are already
 * running to reach their own normal checkpoint/upload/release, the same
 * way they would if nothing had interrupted them — turning a rollout back
 * into a clean handoff instead of a crash.
 *
 * runtime = "nodejs" (build fix, confirmed live): this app has no
 * middleware.ts and no other edge-runtime entry point, so Next.js's own
 * "no edge server entry exists, drop the edge instrumentation bundle"
 * optimization (build/entries.js) should skip building this file for
 * edge at all — in practice, `next dev --webpack` still attempts an edge
 * compilation pass for it, pulling in the dynamic userSession.js import
 * (-> eventLog.ts -> better-sqlite3 -> node-gyp-build/bindings.js's own
 * `require('fs')`) into that pass, which the edge runtime has no `fs` to
 * satisfy — a real, reproduced crash (`Module not found: Can't resolve
 * 'fs'`), not a hypothetical one. This is the documented, canonical way
 * to tell Next.js this file is nodejs-only and skip the edge compilation
 * pass entirely, rather than relying on the runtime-only
 * `process.env.NEXT_RUNTIME !== "nodejs"` guard below, which only stops
 * the code from EXECUTING under edge — by then webpack has already tried
 * to BUNDLE it. serverExternalPackages (next.config.ts) doesn't help
 * here either: it only externalizes native/Node packages for the nodejs
 * server runtime, never for edge, which has no concept of an external
 * native module at all.
 */
export const runtime = "nodejs";

const GRACE_MS = 8000;

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { waitForNoActiveCheckouts, getActiveCheckoutCount } = await import("./src/storage/userSession.js");

  process.on("SIGTERM", () => {
    void (async () => {
      // eslint-disable-next-line no-console
      console.log(`SIGTERM received — waiting up to ${GRACE_MS}ms for ${getActiveCheckoutCount()} in-flight checkout(s) to finish checkin before exiting.`);
      const finishedCleanly = await waitForNoActiveCheckouts(GRACE_MS);
      if (!finishedCleanly) {
        // eslint-disable-next-line no-console
        console.error(`SIGTERM grace period expired with ${getActiveCheckoutCount()} checkout(s) still active — exiting now; Cloud Run will SIGKILL shortly regardless. Any lock still held will self-heal once it passes its TTL (see EN-124).`);
      }
      process.exit(0);
    })();
  });
}
