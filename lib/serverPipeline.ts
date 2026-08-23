/**
 * Phase 7 Part 1 / Cloud migration prerequisite batch / Cloud Storage
 * checkout/checkin batch: the ONE place the web app constructs the
 * pipeline — every API route imports from here, never re-implements
 * capture, retrieval, extraction, or the router.
 *
 * Node-runtime only (better-sqlite3, local ONNX embeddings) — never
 * import this from a client component or the edge runtime.
 *
 * Cached on `globalThis` because Next.js dev mode re-executes module
 * top-level code on hot reload; without this, every HMR cycle would open
 * a fresh set of SQLite connections to the same files. This now applies
 * ONLY to the stateless, per-process singletons below (embedder, cost
 * tracker, chat/extraction/intent/document/image routers, the shared
 * daily-content cache) — never to per-user data connections.
 *
 * Per-user data (Cloud Storage checkout/checkin batch) no longer lives in
 * any cache at all: runUserSession(uid, work) checks a user's data out of
 * remote storage into this instance's local ephemeral disk, opens fresh
 * EventLog/ProjectionsDb/RetrievalDb/BlobStore connections against that
 * checkout, runs `work`, then checks the (possibly-modified) files back in
 * and releases the per-user lock — every call, no connection survives
 * across requests. See src/storage/userSession.ts for the full sequence
 * and src/storage/userStorageBackend.ts for the backend contract
 * (LocalStorageBackend today; GcsStorageBackend is written but not wired
 * in until the deployment batch).
 *
 * This replaces the getStores(uid)/getBlobStore(uid) pair that used to
 * cache one open connection set per uid on globalThis forever — that
 * model is fundamentally incompatible with checkout/checkin, which needs
 * local disk to be refreshed from remote at the start of each unit of
 * work and safely closed/uploaded at the end, never held open indefinitely
 * (see the collision report accompanying this batch: WAL-mode writes,
 * checkpointing, and the per-user lock's release point all depend on a
 * connection's lifetime being bounded to one request). A useful side
 * effect: this structurally removes two of the three historical
 * HMR-staleness bugs invalidateIfStale() below still guards against for
 * the OTHER cached fields — a per-user DB connection can no longer survive
 * a code change to go stale, because none is ever kept around long enough
 * to.
 *
 * dailyContentCache stays a SINGLE global cache deliberately — its own
 * schema has no user_id column at all (it caches AI-generated daily
 * zodiac content keyed only by sign and date, genuinely the same content
 * for every user sharing a sign on a given day) — sharing it is correct,
 * not an oversight, and it is untouched by the checkout/checkin change.
 *
 * getDevUserId() no longer exists. There is no fallback identity anymore
 * — every route derives userId from a verified request (src/auth/
 * verifyRequest.ts's getVerifiedUserId), and a missing or invalid token
 * fails loudly rather than ever minting or reusing an anonymous user, the
 * same discipline this project already applies to the test DB path
 * (EN-091).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { configureLocalOnlyEmbeddings, createEmbedder, type Embedder } from "../src/embeddings/embedder.js";
import { CostTracker } from "../src/providers/costTracker.js";
import { createDefaultChatRouter, type ChatRouter } from "../src/providers/chatRouter.js";
import { createDefaultRouter, type ExtractionRouter } from "../src/providers/router.js";
import { createDefaultIntentRouter, type IntentRouter } from "../src/conversation/router/intentRouter.js";
import { createDocumentRouter, createImageRouter } from "../src/providers/attachmentRouter.js";
import type { DocumentContentAdapter, ImageContentAdapter } from "../src/providers/attachmentTypes.js";
import { DailyContentCache } from "../src/zodiac/dailyContentCache.js";
import { getUserDataPaths, wipeUserDirectory } from "../src/storage/userDataPaths.js";
import { withUserSession, type UserSessionStores } from "../src/storage/userSession.js";
import { LocalStorageBackend } from "../src/storage/localStorageBackend.js";
import type { UserStorageBackend } from "../src/storage/userStorageBackend.js";

// Not import.meta.dirname: webpack's bundling of API routes doesn't
// support it (confirmed live — undefined at runtime under `next dev
// --webpack`). Next.js always runs with cwd = the project root, which is
// simpler and portable across both bundlers anyway.
export const REPO_ROOT = process.cwd();
export const DEV_DATA_DIR = path.join(REPO_ROOT, "dev-data");
const README_FILE = path.join(DEV_DATA_DIR, "README.txt");

// This Cloud Run instance's ephemeral local disk, standing in for real
// ephemeral disk before deployment adds it for real. Every checkout writes
// here; every checkin uploads from here and leaves the copy in place
// (harmless — the next checkout for that uid wipes-then-refetches, so a
// stale leftover between requests is never re-uploaded by accident, see
// LocalStorageBackend.download). Gitignored, same as dev-data itself.
export const LOCAL_INSTANCE_DIR = path.join(REPO_ROOT, ".local-instance-disk");

const README_TEXT = `This directory holds REAL, PERSISTENT data from interactively feel-testing
Enso via the web app (npm run dev). It is gitignored.

Each authenticated user's data lives in its own subdirectory under
users/<uid>/ (events.db, projections.db, retrieval.db, blobs/) — see
src/storage/userDataPaths.ts. dailyContent.db at this top level is the one
deliberately-shared cache (AI-generated daily zodiac content, no user_id
column at all).

Cloud Storage checkout/checkin batch: this directory is now also the
LOCAL backend's "remote" root (src/storage/localStorageBackend.ts) — every
request checks a user's files out to .local-instance-disk/ and back in
here, exactly as it will check them out of and into a real GCS bucket at
deployment. Still local, still dev data.

This is pre-cutover test/dev data, not production journaling data — see
enso-rebuild-requirements.md Section 12 ("Data migration — RESOLVED: start
clean... nothing is imported"). Delete a single user's data via the web
app's own POST /api/wipe (authenticated, scoped to that user only), or by
removing this directory directly.
`;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Add it to .env before starting the web app.`);
  return value;
}

function ensureDevDataDir(): void {
  fs.mkdirSync(DEV_DATA_DIR, { recursive: true });
  if (!fs.existsSync(README_FILE)) fs.writeFileSync(README_FILE, README_TEXT);
}

/**
 * Deployment seam: still local per this batch's scope (no Dockerfile, no
 * gcloud). Swapping to GcsStorageBackend at deployment is a one-line
 * change here — everything above it (runUserSession, every route) is
 * written against the UserStorageBackend interface, not this concrete
 * class, so nothing else needs to change.
 */
function getStorageBackend(): UserStorageBackend {
  return new LocalStorageBackend(DEV_DATA_DIR);
}

// One turn is at most a couple of LLM calls (chat reply, then extraction),
// each retried at most once via runWithFallback — generous headroom over
// even a slow real case, while still bounding how long a crashed
// instance's abandoned lock blocks the next request for that user. Revisit
// against real production latency once there's data to revisit it with.
const USER_SESSION_LOCK_TTL_MS = 60_000;

interface PipelineGlobals {
  embedderPromise?: Promise<Embedder>;
  costTracker?: CostTracker;
  chatRouter?: ChatRouter;
  extractionRouter?: ExtractionRouter;
  intentRouter?: IntentRouter;
  documentRouter?: { extract: DocumentContentAdapter };
  imageRouter?: { extract: ImageContentAdapter };
  dailyContentCache?: DailyContentCache;
  sourceFingerprint?: string;
}

const g = globalThis as unknown as { __ensoPipeline?: PipelineGlobals };
if (!g.__ensoPipeline) g.__ensoPipeline = {};
const cache = g.__ensoPipeline;

/**
 * Dev-only staleness safeguard. `globalThis` caching survives every HMR
 * cycle by design (see the class doc comment above), but that means any
 * cached instance built via `new X(...)` or `createX(...)` keeps running
 * whatever code existed at construction time forever, even after the
 * source file it came from changes — the object's methods and closures
 * don't retroactively update just because Next.js re-executed the module.
 * This bit three times in one session, each a different cached field:
 * ProjectionsDb missing a newly-added method, the intent router still
 * returning decisions shaped for the pre-refactor schema (crashing on
 * `decision.register.mode`), and the /wipe orphaned-connections bug this
 * file's `resetUserData` already exists to fix. All three were "restart
 * the dev server and it's fine" — this makes that automatic instead of
 * something to remember.
 *
 * Fingerprints every .ts file under src/ and lib/ by path+mtime+size (not
 * content — hashing bytes is needless work for a debounced per-request
 * check) and, if it differs from the fingerprint recorded when the cache
 * was last populated, closes and drops every cached entry so the next
 * getter call rebuilds from the current code. Debounced to at most once
 * per second so an active dev session doesn't pay a directory walk on
 * every request. Never runs in production: a deployed process's code
 * cannot change without an actual restart, which already clears
 * `globalThis` by definition, so this check would be pure overhead there.
 */
function computeSourceFingerprint(): string {
  const parts: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) {
        const stat = fs.statSync(full);
        parts.push(`${full}:${stat.mtimeMs}:${stat.size}`);
      }
    }
  };
  walk(path.join(REPO_ROOT, "src"));
  walk(path.join(REPO_ROOT, "lib"));
  return crypto.createHash("sha1").update(parts.sort().join("|")).digest("hex");
}

let lastFingerprintCheckAt = 0;
const FINGERPRINT_CHECK_INTERVAL_MS = 1000;

function invalidateIfStale(): void {
  if (process.env.NODE_ENV === "production") return;
  const now = Date.now();
  if (now - lastFingerprintCheckAt < FINGERPRINT_CHECK_INTERVAL_MS) return;
  lastFingerprintCheckAt = now;

  const current = computeSourceFingerprint();
  if (cache.sourceFingerprint === current) return;
  const isFirstRun = cache.sourceFingerprint === undefined;
  if (!isFirstRun) {
    cache.dailyContentCache?.close();
    for (const key of Object.keys(cache) as (keyof PipelineGlobals)[]) {
      if (key !== "sourceFingerprint") delete cache[key];
    }
    // eslint-disable-next-line no-console
    console.warn("[serverPipeline] source changed under a running dev server — pipeline cache invalidated, rebuilding on next use.");
  }
  cache.sourceFingerprint = current;
}

/**
 * The Cloud Storage checkout/checkin entry point (replaces the old
 * getStores(uid)/getBlobStore(uid) pair — see this file's header comment
 * for why they couldn't coexist with checkout/checkin). Every caller must
 * have already gone through src/auth/verifyRequest.ts's getVerifiedUserId
 * — this function does not itself verify anything, it only trusts the uid
 * it's given and scopes storage to it. `ensureDevDataDir` still runs here
 * because DEV_DATA_DIR is also LocalStorageBackend's remote root — its
 * README needs to exist regardless of which backend is in play.
 */
export function runUserSession<T>(uid: string, work: (stores: UserSessionStores) => Promise<T>): Promise<T> {
  ensureDevDataDir();
  return withUserSession(getStorageBackend(), LOCAL_INSTANCE_DIR, uid, USER_SESSION_LOCK_TTL_MS, work);
}

export function getEmbedder(): Promise<Embedder> {
  invalidateIfStale();
  if (!cache.embedderPromise) {
    configureLocalOnlyEmbeddings();
    cache.embedderPromise = createEmbedder();
  }
  return cache.embedderPromise;
}

export function getCostTracker(): CostTracker {
  invalidateIfStale();
  if (!cache.costTracker) cache.costTracker = new CostTracker();
  return cache.costTracker;
}

export function getChatRouter(): ChatRouter {
  invalidateIfStale();
  if (!cache.chatRouter) cache.chatRouter = createDefaultChatRouter({ openai: requireEnv("OPENAI_API_KEY"), gemini: requireEnv("GEMINI_API_KEY") }, getCostTracker());
  return cache.chatRouter;
}

export function getExtractionRouter(): ExtractionRouter {
  invalidateIfStale();
  if (!cache.extractionRouter) cache.extractionRouter = createDefaultRouter({ openai: requireEnv("OPENAI_API_KEY"), gemini: requireEnv("GEMINI_API_KEY") }, getCostTracker());
  return cache.extractionRouter;
}

export function getIntentRouter(): IntentRouter {
  invalidateIfStale();
  if (!cache.intentRouter) cache.intentRouter = createDefaultIntentRouter({ openai: requireEnv("OPENAI_API_KEY"), gemini: requireEnv("GEMINI_API_KEY") }, getCostTracker());
  return cache.intentRouter;
}

export function getDocumentRouter(): { extract: DocumentContentAdapter } {
  invalidateIfStale();
  if (!cache.documentRouter) cache.documentRouter = createDocumentRouter({ openai: requireEnv("OPENAI_API_KEY"), gemini: requireEnv("GEMINI_API_KEY") }, getCostTracker());
  return cache.documentRouter;
}

export function getImageRouter(): { extract: ImageContentAdapter } {
  invalidateIfStale();
  if (!cache.imageRouter) cache.imageRouter = createImageRouter({ openai: requireEnv("OPENAI_API_KEY"), gemini: requireEnv("GEMINI_API_KEY") }, getCostTracker());
  return cache.imageRouter;
}

/** Deliberately global, not per-user — see this file's header comment and src/storage/userDataPaths.ts for why. */
export function getDailyContentCache(): DailyContentCache {
  invalidateIfStale();
  ensureDevDataDir();
  if (!cache.dailyContentCache) cache.dailyContentCache = new DailyContentCache(path.join(DEV_DATA_DIR, "dailyContent.db"));
  return cache.dailyContentCache;
}

/**
 * Historical note: this used to also need to close this process's own
 * cached per-user connections before deleting a user's directory, because
 * an externally-deleted-and-recreated directory left orphaned open file
 * descriptors behind (reproduced live, an earlier session). That entire
 * bug class is gone now that no per-user connection is ever cached across
 * requests (runUserSession above) — there's nothing left to orphan.
 *
 * Still goes through the per-user lock, though: without it, a wipe could
 * race an in-flight checkin from a concurrent request for the same user
 * and have the checkin's upload silently recreate the "wiped" directory
 * right after this deletes it. Scoped strictly to one uid's subdirectory
 * (src/storage/userDataPaths.ts) — never the shared dev-data root, never
 * another user's directory. Also clears any local ephemeral checkout this
 * instance is holding for the user, so a stale local copy can never be
 * re-uploaded on a later checkin and resurrect what was just wiped.
 */
export async function resetUserData(uid: string): Promise<void> {
  const backend = getStorageBackend();
  const handle = await backend.acquireLock(uid, USER_SESSION_LOCK_TTL_MS);
  try {
    wipeUserDirectory(getUserDataPaths(DEV_DATA_DIR, uid), []);
    const localPaths = getUserDataPaths(LOCAL_INSTANCE_DIR, uid);
    fs.rmSync(localPaths.dir, { recursive: true, force: true });
  } finally {
    await backend.releaseLock(uid, handle);
  }
}
