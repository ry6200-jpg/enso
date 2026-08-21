/**
 * Chunking comparison (EN-035/062, Section 12 Q4): measures retrieval
 * quality at two chunk sizes on a synthetic corpus with known "needle"
 * facts, so the recommendation is based on measured behavior, not just
 * intuition. No network calls — local embeddings only.
 * Run with: node_modules/.bin/tsx scripts/chunkingComparison.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RetrievalDb } from "../src/retrieval/retrievalDb.js";
import { rebuildRetrievalIndex } from "../src/retrieval/rebuildRetrievalIndex.js";
import { rankByFts } from "../src/retrieval/ftsRank.js";
import { rankByVector } from "../src/retrieval/vectorRank.js";
import { configureLocalOnlyEmbeddings, createEmbedder } from "../src/embeddings/embedder.js";
import { CHUNKING_PRESETS } from "../src/retrieval/chunking.js";
import { EventLog } from "../src/events/eventLog.js";

const USER_ID = "01JCHUNKCOMPAREUSER0000000";

// A synthetic multi-page document with distinct, findable "needle" facts
// scattered through generic filler paragraphs — realistic in shape to a
// real uploaded document (a long trip journal or medical history PDF).
const FILLER_SENTENCE = (n: number) =>
  `Background detail number ${n} is included here only to add realistic bulk to this paragraph and carries no special significance of its own. `;

// Needle facts are embedded INLINE within a long single paragraph, mixed
// with filler sentences on both sides — this is what actually makes chunk
// size matter: a small chunk isolates the needle with little dilution; a
// large chunk buries it in more surrounding filler, which can dilute both
// the FTS term-frequency signal and the vector's averaged/pooled embedding.
// Decoy sentences sharing vocabulary with the query are mixed in elsewhere
// in the document to make retrieval a genuine discrimination task, not a
// free win any chunk size would trivially pass.
const NEEDLES = [
  { query: "allergic to penicillin", fact: "Critically, the patient is allergic to penicillin and must never be prescribed it." },
  { query: "emergency contact phone number", fact: "The emergency contact phone number on file is 555-0182, reachable at any hour." },
  { query: "diagnosed with a heart condition", fact: "Years later he was diagnosed with a heart condition that required ongoing monitoring." },
  { query: "signed the lease on the apartment", fact: "They finally signed the lease on the apartment on the third of the month after a long search." },
  { query: "lost the keys to the storage unit", fact: "He lost the keys to the storage unit somewhere near the trailhead during the hike." }
];

const DECOYS = [
  "She is not allergic to anything as far as the records show, which the nurse noted twice.",
  "The office phone number changed last year but nobody updated the emergency contact card.",
  "He was never formally diagnosed with anything serious, according to the summary.",
  "They almost signed a different lease across town before changing their minds.",
  "She found her own keys right where she left them, no storage unit involved."
];

function buildSyntheticDocument(): string {
  const paragraphs: string[] = [];
  let needleIndex = 0;
  let decoyIndex = 0;

  for (let i = 0; i < 40; i++) {
    let paragraph = "";
    for (let s = 0; s < 6; s++) paragraph += FILLER_SENTENCE(i * 10 + s);

    if (i % 8 === 3 && needleIndex < NEEDLES.length) {
      // Insert the needle fact in the MIDDLE of the filler paragraph, not
      // as its own isolated mini-paragraph — this is what makes a larger
      // chunk size actually dilute it with more surrounding text.
      const mid = Math.floor(paragraph.length / 2);
      paragraph = paragraph.slice(0, mid) + NEEDLES[needleIndex]!.fact + " " + paragraph.slice(mid);
      needleIndex++;
    } else if (i % 8 === 6 && decoyIndex < DECOYS.length) {
      const mid = Math.floor(paragraph.length / 2);
      paragraph = paragraph.slice(0, mid) + DECOYS[decoyIndex]! + " " + paragraph.slice(mid);
      decoyIndex++;
    }
    paragraphs.push(paragraph);
  }
  return paragraphs.join("\n\n");
}

async function evaluate(configName: string, config: { targetSize: number; overlap: number }, fullText: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enso-chunking-cmp-"));
  const eventLog = new EventLog(path.join(root, "events.db"));
  const retrievalDb = new RetrievalDb(path.join(root, "retrieval.db"));
  configureLocalOnlyEmbeddings();
  const embedder = await createEmbedder();

  const upload = eventLog.append({ type: "file_uploaded", actor: "user", payload: { filename: "doc.pdf", mimeType: "application/pdf", byteLength: fullText.length, path: "x" }, userId: USER_ID });
  eventLog.append({
    type: "extraction_completed",
    actor: "system",
    payload: { sourceEventId: upload.id, kind: "document", fullText, entities: [] },
    userId: USER_ID
  });

  const buildResult = await rebuildRetrievalIndex(eventLog.listForUser(USER_ID), retrievalDb, USER_ID, embedder, config);

  let ftsTop1Hits = 0;
  let vecTop1Hits = 0;
  let ftsTop3Hits = 0;
  let vecTop3Hits = 0;
  const chunks = retrievalDb.listChunks(USER_ID);
  const chunkById = new Map(chunks.map((c) => [c.id, c]));

  for (const needle of NEEDLES) {
    const ftsRanked = rankByFts(retrievalDb, USER_ID, needle.query, 10);
    if (ftsRanked[0] && chunkById.get(ftsRanked[0].chunkId)?.text.includes(needle.fact)) ftsTop1Hits++;
    if (ftsRanked.slice(0, 3).some((r) => chunkById.get(r.chunkId)?.text.includes(needle.fact))) ftsTop3Hits++;

    const queryEmbedding = await embedder.embed(needle.query);
    const vecRanked = rankByVector(retrievalDb, USER_ID, queryEmbedding, 10);
    if (vecRanked[0] && chunkById.get(vecRanked[0].chunkId)?.text.includes(needle.fact)) vecTop1Hits++;
    if (vecRanked.slice(0, 3).some((r) => chunkById.get(r.chunkId)?.text.includes(needle.fact))) vecTop3Hits++;
  }

  eventLog.close();
  retrievalDb.close();
  fs.rmSync(root, { recursive: true, force: true });

  return {
    configName,
    chunkCount: buildResult.chunksWritten,
    ftsTop1: `${ftsTop1Hits}/${NEEDLES.length}`,
    ftsTop3: `${ftsTop3Hits}/${NEEDLES.length}`,
    vecTop1: `${vecTop1Hits}/${NEEDLES.length}`,
    vecTop3: `${vecTop3Hits}/${NEEDLES.length}`
  };
}

async function main() {
  const fullText = buildSyntheticDocument();
  console.log(`Synthetic document length: ${fullText.length} chars, ${NEEDLES.length} needle facts embedded.\n`);

  const results = [];
  for (const [name, config] of Object.entries(CHUNKING_PRESETS)) {
    console.log(`Evaluating "${name}" (targetSize=${config.targetSize}, overlap=${config.overlap})...`);
    results.push(await evaluate(name, config, fullText));
  }

  console.log("\n=== RESULTS ===");
  for (const r of results) {
    console.log(`${r.configName}: chunks=${r.chunkCount}  FTS top-1=${r.ftsTop1} top-3=${r.ftsTop3}  vector top-1=${r.vecTop1} top-3=${r.vecTop3}`);
  }
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
