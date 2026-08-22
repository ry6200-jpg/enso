/**
 * Phase 7 Part 1: the ONE place the web app constructs the pipeline —
 * every API route imports from here, never re-implements capture,
 * retrieval, extraction, or the router. This is the same dev-data (same
 * paths, same user id file) that scripts/chat.ts (the REPL) reads and
 * writes, so a message sent through either surface is visible from the
 * other — verified live for this phase's report by sending in the UI and
 * reading it back in the REPL.
 *
 * Node-runtime only (better-sqlite3, local ONNX embeddings) — never
 * import this from a client component or the edge runtime.
 *
 * Cached on `globalThis` because Next.js dev mode re-executes module
 * top-level code on hot reload; without this, every HMR cycle would open
 * a fresh set of SQLite connections to the same files.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { newId } from "../src/ids.js";
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

// Not import.meta.dirname: webpack's bundling of API routes doesn't
// support it (confirmed live — undefined at runtime under `next dev
// --webpack`). Next.js always runs with cwd = the project root, which is
// simpler and portable across both bundlers anyway.
export const REPO_ROOT = process.cwd();
export const DEV_DATA_DIR = path.join(REPO_ROOT, "dev-data");
const EVENTS_DB = path.join(DEV_DATA_DIR, "events.db");
const PROJECTIONS_DB = path.join(DEV_DATA_DIR, "projections.db");
const RETRIEVAL_DB = path.join(DEV_DATA_DIR, "retrieval.db");
const BLOBS_DIR = path.join(DEV_DATA_DIR, "blobs");
const USER_ID_FILE = path.join(DEV_DATA_DIR, "user-id.txt");
const README_FILE = path.join(DEV_DATA_DIR, "README.txt");

const README_TEXT = `This directory holds REAL, PERSISTENT data from interactively feel-testing
Enso via the REPL (npm run chat) and the web app (npm run dev). It is
gitignored.

This is pre-cutover test/dev data, not production journaling data — see
enso-rebuild-requirements.md Section 12 ("Data migration — RESOLVED: start
clean... nothing is imported"). Delete it anytime with the REPL's /wipe
command, or by removing this directory directly.
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

export function getDevUserId(): string {
  ensureDevDataDir();
  if (fs.existsSync(USER_ID_FILE)) return fs.readFileSync(USER_ID_FILE, "utf8").trim();
  const id = newId();
  fs.writeFileSync(USER_ID_FILE, id);
  return id;
}

interface PipelineGlobals {
  eventLog?: EventLog;
  projectionsDb?: ProjectionsDb;
  retrievalDb?: RetrievalDb;
  blobStore?: BlobStore;
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
 * file's `resetDevData` already exists to fix. All three were "restart
 * the dev server and it's fine" — this makes that automatic instead of
 * something to remember.
 *
 * Fingerprints every .ts file under src/ and lib/ by path+mtime+size (not
 * content — hashing bytes is needless work for a debounced per-request
 * check) and, if it differs from the fingerprint recorded when the cache
 * was last populated, closes and drops every cached entry so the next
 * getter call rebuilds it from the current code. Debounced to at most
 * once per second so an active dev session doesn't pay a directory walk
 * on every request. Never runs in production: a deployed process's code
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
    cache.eventLog?.close();
    cache.projectionsDb?.close();
    cache.retrievalDb?.close();
    cache.dailyContentCache?.close();
    for (const key of Object.keys(cache) as (keyof PipelineGlobals)[]) {
      if (key !== "sourceFingerprint") delete cache[key];
    }
    // eslint-disable-next-line no-console
    console.warn("[serverPipeline] source changed under a running dev server — pipeline cache invalidated, rebuilding on next use.");
  }
  cache.sourceFingerprint = current;
}

export function getStores(): { eventLog: EventLog; projectionsDb: ProjectionsDb; retrievalDb: RetrievalDb } {
  invalidateIfStale();
  ensureDevDataDir();
  if (!cache.eventLog) cache.eventLog = new EventLog(EVENTS_DB);
  if (!cache.projectionsDb) cache.projectionsDb = new ProjectionsDb(PROJECTIONS_DB);
  if (!cache.retrievalDb) cache.retrievalDb = new RetrievalDb(RETRIEVAL_DB);
  return { eventLog: cache.eventLog, projectionsDb: cache.projectionsDb, retrievalDb: cache.retrievalDb };
}

export function getBlobStore(): BlobStore {
  invalidateIfStale();
  ensureDevDataDir();
  if (!cache.blobStore) cache.blobStore = new BlobStore(BLOBS_DIR);
  return cache.blobStore;
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

export function getDailyContentCache(): DailyContentCache {
  invalidateIfStale();
  if (!cache.dailyContentCache) cache.dailyContentCache = new DailyContentCache(path.join(DEV_DATA_DIR, "dailyContent.db"));
  return cache.dailyContentCache;
}

/**
 * The gap that made /wipe (correctly, at the file level — see
 * scripts/chat.ts's performWipe) look broken through the web app: this
 * module caches EventLog/ProjectionsDb/RetrievalDb/DailyContentCache
 * connections on globalThis so Next.js dev-mode hot reload doesn't reopen
 * them every HMR cycle. But an EXTERNAL wipe (the REPL, a separate OS
 * process, deleting and recreating ./dev-data) has no way to touch this
 * process's already-open file descriptors — they silently become bound
 * to the deleted (but still-readable/writable-via-fd) old files. Reads
 * through the web app after that point return whatever was last cached;
 * writes go into those orphaned files, invisible to any fresh connection
 * at the real path (the REPL, a direct query, or this same process after
 * a restart) — reproduced live and confirmed: a message sent through the
 * web app after an external wipe never appeared in a subsequent direct
 * query of events.db.
 *
 * Fix: give the web app's OWN process a wipe path that closes its own
 * cached connections before deleting ./dev-data, so nothing is ever
 * orphaned. This is the same underlying delete-and-recreate operation
 * scripts/chat.ts's /wipe already does — exposed here so it can run
 * in-process for the surface that actually holds long-lived connections.
 * A wipe triggered externally (REPL) while the web app keeps running
 * still requires restarting the web app — no in-process fix can reach
 * into a different OS process's file descriptors.
 */
export function resetDevData(): void {
  cache.eventLog?.close();
  cache.projectionsDb?.close();
  cache.retrievalDb?.close();
  cache.dailyContentCache?.close();
  fs.rmSync(DEV_DATA_DIR, { recursive: true, force: true });
  cache.eventLog = undefined;
  cache.projectionsDb = undefined;
  cache.retrievalDb = undefined;
  cache.blobStore = undefined;
  cache.dailyContentCache = undefined;
  ensureDevDataDir();
}
