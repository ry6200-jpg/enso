/**
 * One-off, not committed to any npm script: seeds ./dev-data with enough
 * short, keyword-sharing messages that a real hybrid-search query against
 * them exceeds the context-assembly chunk budget (8), for a live
 * demonstration of explicit (never-silent) retrieval truncation. Costs no
 * API calls — captureMessage + rebuildRetrievalIndex only.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventLog } from "../src/events/eventLog.js";
import { RetrievalDb } from "../src/retrieval/retrievalDb.js";
import { rebuildRetrievalIndex } from "../src/retrieval/rebuildRetrievalIndex.js";
import { configureLocalOnlyEmbeddings, createEmbedder } from "../src/embeddings/embedder.js";
import { captureMessage } from "../src/capture/messageCapture.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEV_DATA_DIR = path.join(__dirname, "..", "dev-data");
const userId = fs.readFileSync(path.join(DEV_DATA_DIR, "user-id.txt"), "utf8").trim();

const eventLog = new EventLog(path.join(DEV_DATA_DIR, "events.db"));
const retrievalDb = new RetrievalDb(path.join(DEV_DATA_DIR, "retrieval.db"));

for (let i = 1; i <= 12; i++) {
  captureMessage(eventLog, { userId, text: `Project Zephyr status update #${i}: still on track, no blockers this week.` });
}

configureLocalOnlyEmbeddings();
const embedder = await createEmbedder();
const result = await rebuildRetrievalIndex(eventLog.listForUser(userId), retrievalDb, userId, embedder);
console.log("Seeded 12 Project Zephyr messages. Retrieval rebuild result:", result);

eventLog.close();
retrievalDb.close();
