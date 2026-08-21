/**
 * `npm run chat` — Phase 5 Part 3. Minimal terminal chat against real
 * providers, with real, persistent storage under ./dev-data. This is
 * deliberately not a demo/fixture script: it is the first place Enso
 * actually exists as something a person can talk to, ahead of a real UI
 * (Phase 7). ./dev-data is gitignored and explicitly labeled pre-cutover
 * data (Section 12: "Data migration — RESOLVED: start clean... nothing is
 * imported") — this is feel-testing storage, not the eventual production
 * store, and /wipe exists specifically so it never needs to be treated as
 * precious.
 *
 * Run with real API keys loaded: `npm run chat` (the script itself is
 * `node --env-file=.env --import tsx scripts/chat.ts`, per this project's
 * established env-loading convention — see tests/*.live.test.ts).
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { newId } from "../src/ids.js";
import { EventLog } from "../src/events/eventLog.js";
import { ProjectionsDb } from "../src/projections/db.js";
import { rebuildProjections } from "../src/projections/rebuild.js";
import { RetrievalDb } from "../src/retrieval/retrievalDb.js";
import { rebuildRetrievalIndex } from "../src/retrieval/rebuildRetrievalIndex.js";
import { configureLocalOnlyEmbeddings, createEmbedder, type Embedder } from "../src/embeddings/embedder.js";
import { CostTracker } from "../src/providers/costTracker.js";
import { createDefaultChatRouter } from "../src/providers/chatRouter.js";
import { createDefaultRouter, type ExtractionRouter } from "../src/providers/router.js";
import { extractMessageWithResilience } from "../src/extraction/resilientExtraction.js";
import { sendMessage, type ReplySentPayload, type SendMessageDeps } from "../src/conversation/chatPipeline.js";
import { createDefaultIntentRouter } from "../src/conversation/router/intentRouter.js";
import type { RecentTurnForPrompt } from "../src/persona/systemPrompt.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const DEV_DATA_DIR = path.join(REPO_ROOT, "dev-data");
const EVENTS_DB = path.join(DEV_DATA_DIR, "events.db");
const PROJECTIONS_DB = path.join(DEV_DATA_DIR, "projections.db");
const RETRIEVAL_DB = path.join(DEV_DATA_DIR, "retrieval.db");
const USER_ID_FILE = path.join(DEV_DATA_DIR, "user-id.txt");
const README_FILE = path.join(DEV_DATA_DIR, "README.txt");
const WIPE_CONFIRMATION_PHRASE = "wipe dev data";

const README_TEXT = `This directory holds REAL, PERSISTENT data from interactively feel-testing
Enso via \`npm run chat\` (Phase 5 Part 3). It is gitignored.

This is pre-cutover test/dev data, not production journaling data — see
enso-rebuild-requirements.md Section 12 ("Data migration — RESOLVED: start
clean... nothing is imported"). Delete it anytime with the REPL's /wipe
command, or by removing this directory directly.
`;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Run \`npm run chat\` with real API keys in .env (see .env.example / tests/*.live.test.ts).`);
  }
  return value;
}

function ensureDevDataDir(): boolean {
  const isFresh = !fs.existsSync(DEV_DATA_DIR);
  fs.mkdirSync(DEV_DATA_DIR, { recursive: true });
  fs.writeFileSync(README_FILE, README_TEXT);
  return isFresh;
}

function loadOrCreateDevUserId(): string {
  if (fs.existsSync(USER_ID_FILE)) {
    return fs.readFileSync(USER_ID_FILE, "utf8").trim();
  }
  const id = newId();
  fs.writeFileSync(USER_ID_FILE, id);
  return id;
}

interface Stores {
  eventLog: EventLog;
  projectionsDb: ProjectionsDb;
  retrievalDb: RetrievalDb;
}

function openStores(): Stores {
  return {
    eventLog: new EventLog(EVENTS_DB),
    projectionsDb: new ProjectionsDb(PROJECTIONS_DB),
    retrievalDb: new RetrievalDb(RETRIEVAL_DB)
  };
}

function closeStores(stores: Stores): void {
  stores.eventLog.close();
  stores.projectionsDb.close();
  stores.retrievalDb.close();
}

/** Pulls one delimited block back out of the assembled system prompt for /debug display, rather than plumbing a second return path through contextAssembly.ts just for this. */
function extractBlock(systemPrompt: string, label: string): string {
  const begin = `=== ${label} (begin) ===`;
  const end = `=== ${label} (end) ===`;
  const start = systemPrompt.indexOf(begin);
  const stop = systemPrompt.indexOf(end);
  if (start === -1 || stop === -1) return "(block not found)";
  return systemPrompt.slice(start, stop + end.length);
}

async function main(): Promise<void> {
  const openaiKey = requireEnv("OPENAI_API_KEY");
  const geminiKey = requireEnv("GEMINI_API_KEY");

  const wasFresh = ensureDevDataDir();
  let userId = loadOrCreateDevUserId();
  let stores = openStores();

  configureLocalOnlyEmbeddings();
  const embedder: Embedder = await createEmbedder();

  const costTracker = new CostTracker();
  const chatRouter = createDefaultChatRouter({ openai: openaiKey, gemini: geminiKey }, costTracker);
  const extractionRouter: ExtractionRouter = createDefaultRouter({ openai: openaiKey, gemini: geminiKey }, costTracker);
  const intentRouter = createDefaultIntentRouter({ openai: openaiKey, gemini: geminiKey }, costTracker);

  let recentTurns: RecentTurnForPrompt[] = [];
  let debugOn = false;

  console.log("Enso — dev chat (Phase 5 Part 3 / Phase 6 gates)");
  console.log(`Storage: ${DEV_DATA_DIR} (${wasFresh ? "fresh" : "existing"})`);
  console.log("Commands: /new (reset conversation window, same stores) · /wipe (destroy dev-data) · /debug (toggle context display)");
  console.log("Ctrl+D to exit.\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  async function refreshMemoryAfterTurn(deps: SendMessageDeps, messageEventId: string): Promise<void> {
    const messageEvent = deps.eventLog.getById(messageEventId)!;
    const knownPeopleNames = deps.projectionsDb.listEntities(userId).map((e) => e.name);
    await extractMessageWithResilience(deps.eventLog, extractionRouter, messageEvent, undefined, knownPeopleNames);

    const allEvents = deps.eventLog.listForUser(userId);
    rebuildProjections(allEvents, deps.projectionsDb, userId);
    await rebuildRetrievalIndex(allEvents, deps.retrievalDb, userId, embedder);
  }

  async function performWipe(): Promise<void> {
    closeStores(stores);
    fs.rmSync(DEV_DATA_DIR, { recursive: true, force: true });
    ensureDevDataDir();
    userId = loadOrCreateDevUserId();
    stores = openStores();
    recentTurns = [];
    console.log(`dev-data wiped. Starting fresh at ${DEV_DATA_DIR}.\n`);
  }

  // A single `for await` loop is the only reader of `rl` in this file — a
  // second, nested `rl.question()` call for the /wipe confirmation (the
  // obvious approach) hangs forever against piped/non-TTY stdin (confirmed
  // live: readline/promises' `question()` only reliably resolves once per
  // process against a piped stream). /wipe's confirmation is instead just
  // state carried to the next loop iteration, so there's ever only one
  // consumer of the stream.
  let awaitingWipeConfirmation = false;

  process.stdout.write("You: ");
  for await (const rawLine of rl) {
    const line = rawLine.trim();

    if (awaitingWipeConfirmation) {
      awaitingWipeConfirmation = false;
      if (line === WIPE_CONFIRMATION_PHRASE) {
        await performWipe();
      } else {
        console.log("Confirmation phrase didn't match — wipe cancelled.\n");
      }
      process.stdout.write("You: ");
      continue;
    }

    if (line === "") {
      process.stdout.write("You: ");
      continue;
    }

    if (line === "/new") {
      recentTurns = [];
      console.log("(new conversation window — same stores)\n");
      process.stdout.write("You: ");
      continue;
    }
    if (line === "/debug") {
      debugOn = !debugOn;
      console.log(`(debug context display: ${debugOn ? "ON" : "OFF"})\n`);
      process.stdout.write("You: ");
      continue;
    }
    if (line === "/wipe") {
      console.log(`\nThis destroys everything under ${DEV_DATA_DIR} — all events, projections, and the retrieval index.`);
      process.stdout.write(`Type exactly "${WIPE_CONFIRMATION_PHRASE}" to confirm, or anything else to cancel: `);
      awaitingWipeConfirmation = true;
      continue;
    }

    const deps: SendMessageDeps = { eventLog: stores.eventLog, retrievalDb: stores.retrievalDb, projectionsDb: stores.projectionsDb, embedder, chatRouter, intentRouter };

    let result;
    try {
      result = await sendMessage(deps, { userId, text: line, recentTurns });
    } catch (err) {
      console.log(`\n(reply failed — your message was still saved: ${err instanceof Error ? err.message : String(err)})\n`);
      process.stdout.write("You: ");
      continue;
    }

    console.log(`\nEnso: ${result.replyText}\n`);
    recentTurns = [...recentTurns, { role: "user", text: line }, { role: "enso", text: result.replyText }];

    if (debugOn) {
      const r = result.debug.retrieval;
      const w = result.debug.recentWindow;
      const payload = result.replyEvent.payload as ReplySentPayload;
      console.log("--- debug: context injected this turn ---");
      console.log(`retrieval: mode=${r.mode} query=${JSON.stringify(r.query)} candidates=${r.candidateCount} injected=${r.injectedChunkIds.length} truncated=${r.truncated}`);
      console.log(`recent window: available=${w.availableTurns} injected=${w.injectedTurns} truncated=${w.truncated}`);
      console.log(
        `router: used=${payload.router.used} provider=${payload.router.provider ?? "-"} certified=${payload.router.certified}${payload.router.failureReason ? ` failureReason=${JSON.stringify(payload.router.failureReason)}` : ""}`
      );
      console.log(
        `gates: circleBackFired=${payload.gateActions.circleBackFired ? JSON.stringify(payload.gateActions.circleBackFired) : "null"} attestationConfirmedEventId=${payload.gateActions.attestationConfirmedEventId ?? "null"}`
      );
      console.log(extractBlock(result.debug.systemPrompt, "RETRIEVED MEMORY"));
      console.log(extractBlock(result.debug.systemPrompt, "RECENT CONVERSATION"));
      console.log("--- end debug ---\n");
    }

    try {
      await refreshMemoryAfterTurn(deps, result.messageEvent.id);
    } catch (err) {
      console.log(`(memory update after this turn failed — the message and reply are still saved: ${err instanceof Error ? err.message : String(err)})\n`);
    }

    process.stdout.write("You: ");
  }

  closeStores(stores);
  console.log(`\nSession spend: $${costTracker.totalUsd().toFixed(4)}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
