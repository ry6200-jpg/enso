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
 * (LocalStorageBackend for local dev/every test; GcsStorageBackend when
 * GCS_BUCKET_NAME is set — see getStorageBackend below).
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
import os from "node:os";
import path from "node:path";
import { configureLocalOnlyEmbeddings, createEmbedder, type Embedder } from "../src/embeddings/embedder.js";
import { CostTracker } from "../src/providers/costTracker.js";
import { createDefaultChatRouter, type ChatRouter } from "../src/providers/chatRouter.js";
import { createDefaultRouter, type ExtractionRouter } from "../src/providers/router.js";
import { createDefaultIntentRouter, type IntentRouter } from "../src/conversation/router/intentRouter.js";
import { createDocumentRouter, createImageRouter } from "../src/providers/attachmentRouter.js";
import type { DocumentContentAdapter, ImageContentAdapter } from "../src/providers/attachmentTypes.js";
import { DailyContentCache } from "../src/zodiac/dailyContentCache.js";
import { getUserDataPaths } from "../src/storage/userDataPaths.js";
import { withReadOnlyUserSession, withUserSession, type UserSessionStores } from "../src/storage/userSession.js";
import { LocalStorageBackend } from "../src/storage/localStorageBackend.js";
import { GcsStorageBackend } from "../src/storage/gcsStorageBackend.js";
import type { UserStorageBackend } from "../src/storage/userStorageBackend.js";

// Not import.meta.dirname: webpack's bundling of API routes doesn't
// support it (confirmed live — undefined at runtime under `next dev
// --webpack`). Next.js always runs with cwd = the project root, which is
// simpler and portable across both bundlers anyway.
export const REPO_ROOT = process.cwd();
export const DEV_DATA_DIR = path.join(REPO_ROOT, "dev-data");
const README_FILE = path.join(DEV_DATA_DIR, "README.txt");

/**
 * Live-caught incident (deployment batch, post-Stage-3): every route 500'd
 * from the very first sign-in with `EACCES: permission denied, mkdir
 * '/app/dev-data'`. Root cause: DEV_DATA_DIR is REPO_ROOT-relative
 * (process.cwd()), which resolves to /app in the container — writable by
 * root at image-build time, but the runtime process runs as the non-root
 * `nextjs` user (Dockerfile), which owns only the specific paths the build
 * explicitly chowned. `ensureDevDataDir()` and `getDailyContentCache()`
 * were calling `mkdirSync` under DEV_DATA_DIR unconditionally — including
 * in cloud mode, where DEV_DATA_DIR isn't even the storage backend in use
 * (GcsStorageBackend is) — so the mkdir failed on literally the first
 * request, before checkout/checkin ever ran.
 *
 * isCloudMode() is the one place that distinction is made now — every
 * function below that touches a local path checks it, rather than each
 * silently assuming DEV_DATA_DIR is always safe to write.
 */
function isCloudMode(): boolean {
  return Boolean(process.env.GCS_BUCKET_NAME);
}

// This Cloud Run instance's OWN ephemeral local disk — genuinely writable
// by the runtime user in every environment, unlike REPO_ROOT-relative
// paths in the deployed container (see isCloudMode's comment above: this
// is exactly the path class that incident was about). os.tmpdir() resolves
// to /tmp in the container (world-writable, tmpfs-backed on Cloud Run —
// worth knowing: checked-out files here count against the instance's
// memory budget, not separate disk) and to the OS temp dir locally, always
// writable by whoever is running the process. Used for BOTH modes now,
// deliberately — one code path, not an environment-conditional one, for
// exactly the class of path this incident showed can't be assumed correct
// just because it works locally by accident.
//
// Every checkout writes here; every checkin uploads from here and leaves
// the copy in place (harmless — the next checkout for that uid
// wipes-then-refetches, so a stale leftover between requests is never
// re-uploaded by accident, see LocalStorageBackend.download).
export const LOCAL_INSTANCE_DIR = path.join(os.tmpdir(), "enso-instance-disk");

// The daily-content cache's own writable home (see getDailyContentCache
// below) — deliberately NOT inside LOCAL_INSTANCE_DIR, which is per-user
// checkout scratch space that gets wiped-and-refetched on every checkout;
// this cache is global/cross-user and must never be swept up in that.
const SHARED_CACHE_DIR = path.join(os.tmpdir(), "enso-shared-cache");

const README_TEXT = `This directory holds REAL, PERSISTENT data from interactively feel-testing
Enso via the web app (npm run dev). It is gitignored.

Each authenticated user's data lives in its own subdirectory under
users/<uid>/ (events.db, projections.db, retrieval.db, blobs/) — see
src/storage/userDataPaths.ts.

Cloud Storage checkout/checkin batch: this directory is now also the
LOCAL backend's "remote" root (src/storage/localStorageBackend.ts, used
whenever GCS_BUCKET_NAME is unset) — every request checks a user's files
out to the OS temp dir and back in here, exactly as it will check them out
of and into a real GCS bucket in cloud mode. Still local, still dev data.
The daily-content cache (AI-generated zodiac content, no user_id column at
all, deliberately shared across users) no longer lives in this directory —
it's always under the OS temp dir now too, in both modes (see
lib/serverPipeline.ts's SHARED_CACHE_DIR).

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
 * Fail-loud writability check — same discipline as EN-091's test-DB-path
 * rule ("must FAIL LOUDLY if the test DB path is unset or misresolved...
 * never fall back to a real database path"), applied to the production
 * data paths: a misconfigured/unwritable path must never surface as a raw
 * EACCES three stack frames deep on whatever route a user happens to hit
 * first. Runs lazily, on first real use (see ensureDataPathsWritable
 * below), not at module top-level — this file is imported by every route,
 * which `next build`'s page-data/tracing step also imports, and a
 * top-level throw risks firing during the build rather than only at
 * request time. Memoized so it's a one-time probe per process, not a
 * per-request filesystem round-trip.
 */
function assertWritable(dir: string, label: string): void {
  const probe = path.join(dir, `.enso-writability-probe-${process.pid}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(probe, "");
    fs.unlinkSync(probe);
  } catch (err) {
    throw new Error(`${label} (${dir}) is not writable by this process — refusing to proceed. Underlying error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

let dataPathsWritabilityChecked = false;
function ensureDataPathsWritable(): void {
  if (dataPathsWritabilityChecked) return;
  dataPathsWritabilityChecked = true;
  if (!isCloudMode()) assertWritable(DEV_DATA_DIR, "Local dev/remote data root (DEV_DATA_DIR)");
  assertWritable(LOCAL_INSTANCE_DIR, "This instance's ephemeral checkout disk (LOCAL_INSTANCE_DIR)");
  assertWritable(SHARED_CACHE_DIR, "The shared daily-content cache directory (SHARED_CACHE_DIR)");
}

/**
 * Deployment seam: GCS_BUCKET_NAME set (Cloud Run) switches to
 * GcsStorageBackend against that bucket; unset (local dev, every test)
 * keeps LocalStorageBackend against DEV_DATA_DIR. Everything above this
 * function (runUserSession, every route) is written against the
 * UserStorageBackend interface, not either concrete class, so nothing else
 * needs to change either way. Not cached on globalThis — construction is
 * cheap (no network call happens until a caller actually
 * downloads/uploads/locks), matching LocalStorageBackend's existing
 * per-call construction rather than adding a new cached field's worth of
 * HMR-staleness surface for no real benefit.
 */
function getStorageBackend(): UserStorageBackend {
  if (isCloudMode()) return new GcsStorageBackend(process.env.GCS_BUCKET_NAME!);
  return new LocalStorageBackend(DEV_DATA_DIR);
}

// One turn is at most a couple of LLM calls (chat reply, then extraction),
// each retried at most once via runWithFallback — generous headroom over
// even a slow real case, while still bounding how long a crashed
// instance's abandoned lock blocks the next request for that user.
//
// Storage durability batch, PART 2: reaffirmed rather than changed after
// the deploy-race stale-lock investigation — the tradeoff is real either
// way. Shorter risks breaking a lock still held by a genuinely live but
// slow container (an unusually slow LLM response, a large checkout),
// which without PART 2's fencing check (userSession.ts, isLockCurrent)
// could let two writers be active at once; longer leaves a real crash's
// user locked out for longer. PART 3's SIGTERM handling now gives a
// normal rollout up to its own grace window to finish checkin cleanly
// instead of crashing mid-checkout, so an expired lock after this batch
// should represent an actual dead holder far more often than before —
// that supports keeping this bound tight rather than loosening it
// defensively. Revisit against real production latency once there's
// data to revisit it with.
const USER_SESSION_LOCK_TTL_MS = 60_000;

// Storage durability batch, PART 2: a free-text diagnostic identity
// recorded on the lock object so a stuck lock's holder is nameable in
// production, not a mystery — plays no role in the locking decision
// itself (still expiresAt + a real compare-and-swap). K_REVISION is
// Cloud Run's own env var (e.g. "enso-00019-mdm"); the instance half has
// no equivalent standard env var short of an async metadata-server call
// this doesn't need, so a UUID generated once per process at module load
// stands in for "this specific running container" for its whole
// lifetime, at zero network cost.
const LOCK_HOLDER_ID = `${process.env.K_REVISION ?? "local"}/${crypto.randomUUID()}`;

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
 * it's given and scopes storage to it. `ensureDevDataDir` runs ONLY in
 * local mode — DEV_DATA_DIR is LocalStorageBackend's remote root there,
 * but is not touched at all (and must not be) once GCS_BUCKET_NAME is set.
 */
export function runUserSession<T>(uid: string, work: (stores: UserSessionStores) => Promise<T>): Promise<T> {
  ensureDataPathsWritable();
  if (!isCloudMode()) ensureDevDataDir();
  return withUserSession(getStorageBackend(), LOCAL_INSTANCE_DIR, uid, USER_SESSION_LOCK_TTL_MS, work, LOCK_HOLDER_ID);
}

/**
 * Refresh-blank-chat batch: the read-only sibling of runUserSession, for
 * routes whose `work` never writes anything — see
 * src/storage/userSession.ts's withReadOnlyUserSession for the real
 * mechanism (skips checkin, releases the lock as soon as the read
 * finishes) and the DANGER note on misusing it for something that writes.
 * Introduced specifically because GET /api/history and
 * GET /api/zodiac-sidebar's birthdate read were observed colliding at the
 * per-user lock in real production logs — both fire on the same page
 * load, and neither had anything to check in.
 */
export function runReadOnlyUserSession<T>(uid: string, work: (stores: UserSessionStores) => Promise<T>): Promise<T> {
  ensureDataPathsWritable();
  if (!isCloudMode()) ensureDevDataDir();
  return withReadOnlyUserSession(getStorageBackend(), LOCAL_INSTANCE_DIR, uid, USER_SESSION_LOCK_TTL_MS, work, LOCK_HOLDER_ID);
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

/**
 * Deliberately global, not per-user — see this file's header comment and
 * src/storage/userDataPaths.ts for why. Lives under SHARED_CACHE_DIR (OS
 * temp dir), not DEV_DATA_DIR — this cache was one of the two paths that
 * crashed with EACCES in cloud mode before this fix (see isCloudMode's
 * comment): it's local-only in EITHER mode, but DEV_DATA_DIR is only ever
 * safe to write in local mode.
 */
export function getDailyContentCache(): DailyContentCache {
  invalidateIfStale();
  ensureDataPathsWritable();
  fs.mkdirSync(SHARED_CACHE_DIR, { recursive: true });
  if (!cache.dailyContentCache) cache.dailyContentCache = new DailyContentCache(path.join(SHARED_CACHE_DIR, "dailyContent.db"));
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
 * Backend-agnostic by construction, not by an if/else per backend: wiping
 * is "upload an empty directory" — both LocalStorageBackend.upload and
 * GcsStorageBackend.upload already delete whatever exists remotely for
 * this uid before copying from localDir, so pointing that at a directory
 * with nothing in it is a real, already-tested wipe on either backend, not
 * a new code path. (The old version of this function wrote directly to
 * DEV_DATA_DIR, which — like ensureDevDataDir and the old
 * getDailyContentCache — only makes sense for LocalStorageBackend; it
 * would have hit the exact EACCES this batch's incident was about the
 * first time anyone wiped in cloud mode.)
 *
 * Still goes through the per-user lock: without it, a wipe could race an
 * in-flight checkin from a concurrent request for the same user and have
 * the checkin's upload silently recreate the "wiped" directory right after
 * this deletes it. Also clears any local ephemeral checkout this instance
 * is holding for the user, so a stale local copy can never be re-uploaded
 * on a later checkin and resurrect what was just wiped.
 */
export async function resetUserData(uid: string): Promise<void> {
  const backend = getStorageBackend();
  const handle = await backend.acquireLock(uid, USER_SESSION_LOCK_TTL_MS, LOCK_HOLDER_ID);
  try {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "enso-wipe-"));
    try {
      await backend.upload(uid, emptyDir);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
    const localPaths = getUserDataPaths(LOCAL_INSTANCE_DIR, uid);
    fs.rmSync(localPaths.dir, { recursive: true, force: true });
  } finally {
    await backend.releaseLock(uid, handle);
  }
}
