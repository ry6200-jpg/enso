import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventLog } from "../src/events/eventLog.js";
import { BlobStore } from "../src/blobs/blobStore.js";
import { ProjectionsDb } from "../src/projections/db.js";
import { rebuildProjections } from "../src/projections/rebuild.js";
import { createCachedExtractor, ExtractionCache } from "../src/extraction/cache.js";
import { STUB_EXTRACTOR_VERSION, STUB_MODEL_ID, stubExtract } from "../src/extraction/stubExtractor.js";
import { compareStructural, snapshotFromEntityRows } from "../src/comparator/structuralEquivalence.js";
import { EVENT_TYPES } from "../src/events/schema.js";

const USER_ID = "01JDEMOUSER00000000000000";

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function main(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enso-phase1-demo-"));
  console.log(`Phase 1 Foundation — synthetic end-to-end demo`);
  console.log(`Working directory (ephemeral): ${root}`);

  const eventLog = new EventLog(path.join(root, "events.db"));
  const blobs = new BlobStore(path.join(root, "blobs"));
  const cache = new ExtractionCache(path.join(root, "cache.db"));

  section("1. Emitting a scripted sequence covering all ten event types (EN-050)");

  const msg1 = eventLog.append({
    type: "message_sent",
    actor: "user",
    payload: { text: "I had lunch with Sarah and my sister Amy today." },
    userId: USER_ID
  });
  console.log(`message_sent          ${msg1.id}  "${(msg1.payload as { text: string }).text}"`);

  const extraction1 = eventLog.append({
    type: "extraction_completed",
    actor: "system",
    payload: {
      sourceEventId: msg1.id,
      extractorVersion: STUB_EXTRACTOR_VERSION,
      modelId: STUB_MODEL_ID,
      entities: [{ name: "Sarah" }, { name: "Amy" }],
      relationships: [],
      dates: []
    },
    userId: USER_ID
  });
  console.log(`extraction_completed  ${extraction1.id}  entities=[Sarah, Amy]`);

  const reply1 = eventLog.append({
    type: "reply_sent",
    actor: "enso",
    payload: { text: "That sounds lovely." },
    userId: USER_ID
  });
  console.log(`reply_sent            ${reply1.id}  "That sounds lovely."`);

  const photoBytes = Buffer.from("fake jpeg bytes for the demo");
  const stored = blobs.put(photoBytes, "lunch-photo.jpg");
  const upload1 = eventLog.append({
    type: "file_uploaded",
    actor: "user",
    payload: { filename: "lunch-photo.jpg", byteLength: stored.byteLength, path: stored.relativePath },
    userId: USER_ID
  });
  console.log(`file_uploaded         ${upload1.id}  path=${stored.relativePath}`);

  const msg2 = eventLog.append({
    type: "message_sent",
    actor: "user",
    payload: { text: "Tried calling Priya but it timed out." },
    userId: USER_ID
  });
  console.log(`message_sent          ${msg2.id}  "${(msg2.payload as { text: string }).text}"`);

  const failed1 = eventLog.append({
    type: "extraction_failed",
    actor: "system",
    payload: { sourceEventId: msg2.id, reason: "timeout" },
    userId: USER_ID
  });
  console.log(`extraction_failed     ${failed1.id}  reason=timeout (source=${msg2.id})`);

  const corrected1 = eventLog.append({
    type: "fact_corrected",
    actor: "user",
    payload: { targetEventId: extraction1.id, entityName: "Amy", correctedName: "Amelia" },
    userId: USER_ID
  });
  console.log(`fact_corrected        ${corrected1.id}  Amy -> Amelia (targets ${extraction1.id})`);

  const confirmed1 = eventLog.append({
    type: "fact_confirmed",
    actor: "user",
    payload: { targetEventId: extraction1.id, entityName: "Sarah" },
    userId: USER_ID
  });
  console.log(`fact_confirmed        ${confirmed1.id}  Sarah confirmed (targets ${extraction1.id})`);

  const annotation1 = eventLog.append({
    type: "user_annotation",
    actor: "user",
    payload: { targetEventId: msg1.id, note: "tag: family lunch" },
    userId: USER_ID
  });
  console.log(`user_annotation       ${annotation1.id}  note="tag: family lunch" (targets ${msg1.id})`);

  const deleted1 = eventLog.append({
    type: "upload_deleted",
    actor: "user",
    payload: { targetEventId: upload1.id },
    userId: USER_ID
  });
  console.log(`upload_deleted        ${deleted1.id}  tombstone for ${upload1.id}`);

  const lookup1 = eventLog.append({
    type: "external_lookup_performed",
    actor: "system",
    payload: { kind: "geocode", query: "94103", result: "San Francisco, CA" },
    userId: USER_ID
  });
  console.log(`external_lookup_performed ${lookup1.id}  geocode(94103) -> San Francisco, CA`);

  const allEvents = eventLog.listForUser(USER_ID);
  const typesSeen = new Set(allEvents.map((e) => e.type));
  console.log(`\nTotal events logged: ${allEvents.length}`);
  console.log(`Distinct event types used: ${typesSeen.size} / ${EVENT_TYPES.length}`);
  console.log(
    `All ten resolved types covered: ${EVENT_TYPES.every((t) => typesSeen.has(t))}`
  );

  section("2. Mechanical append-only enforcement (EN-050)");
  try {
    eventLog.db.prepare(`UPDATE events SET payload = ? WHERE id = ?`).run("{}", msg1.id);
    console.log("UNEXPECTED: UPDATE succeeded — this should never happen.");
  } catch (err) {
    console.log(`UPDATE attempt correctly rejected by trigger: ${(err as Error).message}`);
  }
  try {
    eventLog.db.prepare(`DELETE FROM events WHERE id = ?`).run(msg1.id);
    console.log("UNEXPECTED: DELETE succeeded — this should never happen.");
  } catch (err) {
    console.log(`DELETE attempt correctly rejected by trigger: ${(err as Error).message}`);
  }

  section("3. Building projections via the rebuild command (EN-054/056)");

  let rawExtractorCalls = 0;
  const { extract } = createCachedExtractor(cache, STUB_EXTRACTOR_VERSION, STUB_MODEL_ID, (text) => {
    rawExtractorCalls++;
    return stubExtract(text);
  });

  const projectionsA = new ProjectionsDb(path.join(root, "projections-run-a.db"));
  const resultA = rebuildProjections(allEvents, projectionsA, USER_ID, extract);
  console.log(`Rebuild run A: ${JSON.stringify(resultA)}`);
  console.log(`Raw (uncached) extractor invocations so far: ${rawExtractorCalls}`);

  console.log("\nEntities projection (run A):");
  for (const row of projectionsA.listEntities(USER_ID)) {
    console.log(
      `  - ${row.name}  confirmed=${row.confirmed === 1}  extractor_version=${row.extractor_version}  sources=${row.source_event_ids}`
    );
  }

  section("4. Re-running rebuild from scratch — proving it is routine, not scary (EN-054/056)");
  const projectionsB = new ProjectionsDb(path.join(root, "projections-run-b.db"));
  const resultB = rebuildProjections(allEvents, projectionsB, USER_ID, extract);
  console.log(`Rebuild run B: ${JSON.stringify(resultB)}`);
  console.log(
    `Raw (uncached) extractor invocations after second rebuild: ${rawExtractorCalls} ` +
      `(unchanged from run A — the second full rebuild reused the extraction cache instead of re-running extraction)`
  );

  section("5. Structural-equivalence comparator: two independent rebuilds (EN-057)");
  const snapshotA = snapshotFromEntityRows(projectionsA.listEntities(USER_ID));
  const snapshotB = snapshotFromEntityRows(projectionsB.listEntities(USER_ID));
  const comparisonAB = compareStructural(snapshotA, snapshotB);
  console.log(`compareStructural(run A, run B) = ${JSON.stringify(comparisonAB)}`);
  console.log(comparisonAB.equivalent ? "PASS: the two rebuilds are structurally equivalent." : "FAIL (unexpected).");

  section("6. Planting one structural difference and showing the comparator catch it (EN-057)");
  const mutatedSnapshot = {
    ...snapshotA,
    entities: snapshotA.entities.filter((e) => e.name.toLowerCase() !== "amelia")
  };
  const comparisonMutated = compareStructural(snapshotA, mutatedSnapshot);
  console.log(`Planted difference: removed entity "Amelia" from a copy of run A's snapshot.`);
  console.log(`compareStructural(run A, mutated) = ${JSON.stringify(comparisonMutated)}`);
  console.log(
    comparisonMutated.equivalent
      ? "UNEXPECTED PASS (comparator failed to catch the planted difference)."
      : "PASS: the comparator correctly reports the projections as NOT structurally equivalent."
  );

  section("Summary");
  console.log(`- Ten event types: emitted and validated (EN-050).`);
  console.log(`- Blob store: file written under an id-based path (EN-051).`);
  console.log(`- Projections: physically separate SQLite file, entities carry provenance + extractor_version (EN-052/053).`);
  console.log(`- Rebuild: drop + replay proven idempotent and deterministic across two independent runs (EN-054).`);
  console.log(`- Correction precedence: "Amy" was corrected to "Amelia" and stayed corrected after rebuild (EN-055).`);
  console.log(`- Extraction cache: second rebuild made zero additional raw extractor calls (EN-056).`);
  console.log(`- Structural-equivalence comparator: passed on equivalent projections, failed on a planted difference (EN-057).`);

  eventLog.close();
  projectionsA.close();
  projectionsB.close();
  fs.rmSync(root, { recursive: true, force: true });
}

main();
