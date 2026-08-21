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
}

const g = globalThis as unknown as { __ensoPipeline?: PipelineGlobals };
if (!g.__ensoPipeline) g.__ensoPipeline = {};
const cache = g.__ensoPipeline;

export function getStores(): { eventLog: EventLog; projectionsDb: ProjectionsDb; retrievalDb: RetrievalDb } {
  ensureDevDataDir();
  if (!cache.eventLog) cache.eventLog = new EventLog(EVENTS_DB);
  if (!cache.projectionsDb) cache.projectionsDb = new ProjectionsDb(PROJECTIONS_DB);
  if (!cache.retrievalDb) cache.retrievalDb = new RetrievalDb(RETRIEVAL_DB);
  return { eventLog: cache.eventLog, projectionsDb: cache.projectionsDb, retrievalDb: cache.retrievalDb };
}

export function getBlobStore(): BlobStore {
  ensureDevDataDir();
  if (!cache.blobStore) cache.blobStore = new BlobStore(BLOBS_DIR);
  return cache.blobStore;
}

export function getEmbedder(): Promise<Embedder> {
  if (!cache.embedderPromise) {
    configureLocalOnlyEmbeddings();
    cache.embedderPromise = createEmbedder();
  }
  return cache.embedderPromise;
}

export function getCostTracker(): CostTracker {
  if (!cache.costTracker) cache.costTracker = new CostTracker();
  return cache.costTracker;
}

export function getChatRouter(): ChatRouter {
  if (!cache.chatRouter) cache.chatRouter = createDefaultChatRouter({ openai: requireEnv("OPENAI_API_KEY"), gemini: requireEnv("GEMINI_API_KEY") }, getCostTracker());
  return cache.chatRouter;
}

export function getExtractionRouter(): ExtractionRouter {
  if (!cache.extractionRouter) cache.extractionRouter = createDefaultRouter({ openai: requireEnv("OPENAI_API_KEY"), gemini: requireEnv("GEMINI_API_KEY") }, getCostTracker());
  return cache.extractionRouter;
}

export function getIntentRouter(): IntentRouter {
  if (!cache.intentRouter) cache.intentRouter = createDefaultIntentRouter({ openai: requireEnv("OPENAI_API_KEY"), gemini: requireEnv("GEMINI_API_KEY") }, getCostTracker());
  return cache.intentRouter;
}

export function getDocumentRouter(): { extract: DocumentContentAdapter } {
  if (!cache.documentRouter) cache.documentRouter = createDocumentRouter({ openai: requireEnv("OPENAI_API_KEY"), gemini: requireEnv("GEMINI_API_KEY") }, getCostTracker());
  return cache.documentRouter;
}

export function getImageRouter(): { extract: ImageContentAdapter } {
  if (!cache.imageRouter) cache.imageRouter = createImageRouter({ openai: requireEnv("OPENAI_API_KEY"), gemini: requireEnv("GEMINI_API_KEY") }, getCostTracker());
  return cache.imageRouter;
}

export function getDailyContentCache(): DailyContentCache {
  if (!cache.dailyContentCache) cache.dailyContentCache = new DailyContentCache(path.join(DEV_DATA_DIR, "dailyContent.db"));
  return cache.dailyContentCache;
}
