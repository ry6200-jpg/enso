/**
 * Phase 7 Part 1 / Cloud migration prerequisite batch: the ONE place the
 * web app constructs the pipeline — every API route imports from here,
 * never re-implements capture, retrieval, extraction, or the router.
 *
 * Node-runtime only (better-sqlite3, local ONNX embeddings) — never
 * import this from a client component or the edge runtime.
 *
 * Cached on `globalThis` because Next.js dev mode re-executes module
 * top-level code on hot reload; without this, every HMR cycle would open
 * a fresh set of SQLite connections to the same files.
 *
 * Per-user data (Cloud migration prerequisite batch, item 2): eventLog,
 * projectionsDb, retrievalDb, and blobStore are now keyed by uid, one set
 * of connections per authenticated user, one directory per user on disk
 * (src/storage/userDataPaths.ts). dailyContentCache stays a SINGLE global
 * cache deliberately — its own schema has no user_id column at all (it
 * caches AI-generated daily zodiac content keyed only by sign and date,
 * genuinely the same content for every user sharing a sign on a given
 * day) — sharing it is correct, not an oversight. Every other cached
 * field (embedder, cost tracker, chat/extraction/intent/document/image
 * routers) is a stateless API-client singleton with no per-user state at
 * all and is unchanged.
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
import { EventLog } from "../src/events/eventLog.js";
import { ProjectionsDb } from "../src/projections/db.js";
import { RetrievalDb } from "../src/retrieval/retrievalDb.js";
import { configureLocalOnlyEmbeddings, createEmbedder, type Embedder } from "../src/embeddings/embedder.js";
import { CostTracker } from "../src/providers/costTracker.js";
import { createDefaultChatRouter, type ChatRouter } from "../src/providers/chatRouter.js";
import { createDefaultRouter, type ExtractionRouter } from "../src/providers/router.js";
import { createDefaultIntentRouter, type IntentRouter } from "../src/conversation/router/intentRouter.js";
import { createDocumentRouter, createImageRouter } from "../src/providers/attachmentRouter.js";
import type { DocumentContentAdapter, ImageContentAdapter } from "../src/providers/attachmentTypes.js";
import { BlobStore } from "../src/blobs/blobStore.js";
import { DailyContentCache } from "../src/zodiac/dailyContentCache.js";
import { getUserDataPaths, sanitizeUidForPath, wipeUserDirectory } from "../src/storage/userDataPaths.js";

// Not import.meta.dirname: webpack's bundling of API routes doesn't
// support it (confirmed live — undefined at runtime under `next dev
// --webpack`). Next.js always runs with cwd = the project root, which is
// simpler and portable across both bundlers anyway.
export const REPO_ROOT = process.cwd();
export const DEV_DATA_DIR = path.join(REPO_ROOT, "dev-data");
const README_FILE = path.join(DEV_DATA_DIR, "README.txt");

const README_TEXT = `This directory holds REAL, PERSISTENT data from interactively feel-testing
Enso via the web app (npm run dev). It is gitignored.

Each authenticated user's data lives in its own subdirectory under
users/<uid>/ (events.db, projections.db, retrieval.db, blobs/) — see
src/storage/userDataPaths.ts. dailyContent.db at this top level is the one
deliberately-shared cache (AI-generated daily zodiac content, no user_id
column at all).

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

interface PipelineGlobals {
  eventLogByUser?: Map<string, EventLog>;
  projectionsDbByUser?: Map<string, ProjectionsDb>;
  retrievalDbByUser?: Map<string, RetrievalDb>;
  blobStoreByUser?: Map<string, BlobStore>;
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

function eventLogMap(): Map<string, EventLog> {
  if (!cache.eventLogByUser) cache.eventLogByUser = new Map();
  return cache.eventLogByUser;
}
function projectionsDbMap(): Map<string, ProjectionsDb> {
  if (!cache.projectionsDbByUser) cache.projectionsDbByUser = new Map();
  return cache.projectionsDbByUser;
}
function retrievalDbMap(): Map<string, RetrievalDb> {
  if (!cache.retrievalDbByUser) cache.retrievalDbByUser = new Map();
  return cache.retrievalDbByUser;
}
function blobStoreMap(): Map<string, BlobStore> {
  if (!cache.blobStoreByUser) cache.blobStoreByUser = new Map();
  return cache.blobStoreByUser;
}

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
 * was last populated, closes and drops every cached entry — now across
 * every user's connections in each per-user map, not just a single field
 * — so the next getter call rebuilds from the current code. Debounced to
 * at most once per second so an active dev session doesn't pay a
 * directory walk on every request. Never runs in production: a deployed
 * process's code cannot change without an actual restart, which already
 * clears `globalThis` by definition, so this check would be pure overhead
 * there.
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
    for (const eventLog of eventLogMap().values()) eventLog.close();
    for (const projectionsDb of projectionsDbMap().values()) projectionsDb.close();
    for (const retrievalDb of retrievalDbMap().values()) retrievalDb.close();
    cache.dailyContentCache?.close();
    for (const key of Object.keys(cache) as (keyof PipelineGlobals)[]) {
      if (key !== "sourceFingerprint") delete cache[key];
    }
    // eslint-disable-next-line no-console
    console.warn("[serverPipeline] source changed under a running dev server — pipeline cache invalidated, rebuilding on next use.");
  }
  cache.sourceFingerprint = current;
}

/** Every caller must have already gone through src/auth/verifyRequest.ts's getVerifiedUserId — this function does not itself verify anything, it only trusts the uid it's given and scopes storage to it. */
export function getStores(uid: string): { eventLog: EventLog; projectionsDb: ProjectionsDb; retrievalDb: RetrievalDb } {
  invalidateIfStale();
  const paths = getUserDataPaths(DEV_DATA_DIR, uid);
  fs.mkdirSync(paths.dir, { recursive: true });
  ensureDevDataDir();

  const eventLogs = eventLogMap();
  if (!eventLogs.has(uid)) eventLogs.set(uid, new EventLog(paths.eventsDb));
  const projectionsDbs = projectionsDbMap();
  if (!projectionsDbs.has(uid)) projectionsDbs.set(uid, new ProjectionsDb(paths.projectionsDb));
  const retrievalDbs = retrievalDbMap();
  if (!retrievalDbs.has(uid)) retrievalDbs.set(uid, new RetrievalDb(paths.retrievalDb));

  return { eventLog: eventLogs.get(uid)!, projectionsDb: projectionsDbs.get(uid)!, retrievalDb: retrievalDbs.get(uid)! };
}

export function getBlobStore(uid: string): BlobStore {
  invalidateIfStale();
  const paths = getUserDataPaths(DEV_DATA_DIR, uid);
  fs.mkdirSync(paths.dir, { recursive: true });
  ensureDevDataDir();

  const blobStores = blobStoreMap();
  if (!blobStores.has(uid)) blobStores.set(uid, new BlobStore(paths.blobsDir));
  return blobStores.get(uid)!;
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
 * The gap that made /wipe (correctly, at the file level) look broken
 * through the web app: this module caches EventLog/ProjectionsDb/
 * RetrievalDb connections on globalThis so Next.js dev-mode hot reload
 * doesn't reopen them every HMR cycle. But an EXTERNAL wipe (a separate OS
 * process deleting and recreating a user's directory) has no way to touch
 * THIS process's already-open file descriptors — they silently become
 * bound to the deleted (but still-readable/writable-via-fd) old files.
 * Reads through the web app after that point return whatever was last
 * cached; writes go into those orphaned files, invisible to any fresh
 * connection at the real path — reproduced live and confirmed in an
 * earlier session with the old single-user version of this bug.
 *
 * Fix: give the web app's OWN process a wipe path that closes its own
 * cached connections for THIS user before deleting THIS user's directory,
 * so nothing is ever orphaned and no other user's data is ever touched.
 * Scoped strictly to one uid's subdirectory (src/storage/userDataPaths.ts)
 * — never the shared dev-data root, never another user's directory.
 */
export function resetUserData(uid: string): void {
  const safeUid = sanitizeUidForPath(uid);
  const paths = getUserDataPaths(DEV_DATA_DIR, uid);

  const openConnections = [eventLogMap().get(safeUid), projectionsDbMap().get(safeUid), retrievalDbMap().get(safeUid)].filter((c): c is NonNullable<typeof c> => c !== undefined);
  wipeUserDirectory(paths, openConnections);

  eventLogMap().delete(safeUid);
  projectionsDbMap().delete(safeUid);
  retrievalDbMap().delete(safeUid);
  blobStoreMap().delete(safeUid);
}
