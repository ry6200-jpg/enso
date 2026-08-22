import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/events/eventLog.js";
import { ProjectionsDb } from "../src/projections/db.js";
import { RetrievalDb } from "../src/retrieval/retrievalDb.js";
import { BlobStore } from "../src/blobs/blobStore.js";
import { rebuildProjections } from "../src/projections/rebuild.js";
import { computeDeletionImpact, computeEclipsedEventIds, deleteUpload, listUploads, type DeletionImpact } from "../src/attachments/uploadDeletion.js";
import type { UploadDeletedPayload } from "../src/attachments/attachmentCapture.js";
import { configureLocalOnlyEmbeddings, createEmbedder, type Embedder } from "../src/embeddings/embedder.js";
import { freshTestDbPath, resolveTestDbDir } from "../src/test/dbPath.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";

let eventLog: EventLog;
let projections: ProjectionsDb;
let retrievalDb: RetrievalDb;
let blobStore: BlobStore;
let embedder: Embedder;

beforeAll(async () => {
  configureLocalOnlyEmbeddings();
  embedder = await createEmbedder();
});

beforeEach(() => {
  eventLog = new EventLog(freshTestDbPath(import.meta.url, "events"));
  projections = new ProjectionsDb(freshTestDbPath(import.meta.url, "projections"));
  retrievalDb = new RetrievalDb(freshTestDbPath(import.meta.url, "retrieval"));
  blobStore = new BlobStore(resolveTestDbDir(import.meta.url) + "-blobs");
});

describe("computeEclipsedEventIds (EN-065 shared kernel)", () => {
  it("returns an empty set when there are no upload_deleted events at all", () => {
    const events = eventLog.listForUser(PRIMARY_USER_ID);
    expect(computeEclipsedEventIds(events).size).toBe(0);
  });

  it("eclipses the upload's own event id plus every extraction_completed derived from it", () => {
    const upload = eventLog.append({ type: "file_uploaded", actor: "user", payload: { filename: "x.pdf", mimeType: "application/pdf", byteLength: 1, path: "x" }, userId: PRIMARY_USER_ID });
    const extraction = eventLog.append({ type: "extraction_completed", actor: "system", payload: { sourceEventId: upload.id, kind: "document" }, userId: PRIMARY_USER_ID });
    eventLog.append({ type: "upload_deleted", actor: "user", payload: { uploadEventId: upload.id, filename: "x.pdf", removedFactCount: 0, preservedFactCount: 0 }, userId: PRIMARY_USER_ID });

    const eclipsed = computeEclipsedEventIds(eventLog.listForUser(PRIMARY_USER_ID));
    expect(eclipsed.has(upload.id)).toBe(true);
    expect(eclipsed.has(extraction.id)).toBe(true);
  });

  it("never eclipses an unrelated upload's own extraction", () => {
    const deletedUpload = eventLog.append({ type: "file_uploaded", actor: "user", payload: { filename: "deleted.pdf", mimeType: "application/pdf", byteLength: 1, path: "x" }, userId: PRIMARY_USER_ID });
    const survivingUpload = eventLog.append({ type: "file_uploaded", actor: "user", payload: { filename: "kept.pdf", mimeType: "application/pdf", byteLength: 1, path: "y" }, userId: PRIMARY_USER_ID });
    const survivingExtraction = eventLog.append({ type: "extraction_completed", actor: "system", payload: { sourceEventId: survivingUpload.id, kind: "document" }, userId: PRIMARY_USER_ID });
    eventLog.append({ type: "upload_deleted", actor: "user", payload: { uploadEventId: deletedUpload.id, filename: "deleted.pdf", removedFactCount: 0, preservedFactCount: 0 }, userId: PRIMARY_USER_ID });

    const eclipsed = computeEclipsedEventIds(eventLog.listForUser(PRIMARY_USER_ID));
    expect(eclipsed.has(survivingUpload.id)).toBe(false);
    expect(eclipsed.has(survivingExtraction.id)).toBe(false);
  });
});

describe("listUploads", () => {
  it("lists an upload with its extraction status", () => {
    const upload = eventLog.append({ type: "file_uploaded", actor: "user", payload: { filename: "notes.pdf", mimeType: "application/pdf", byteLength: 1, path: "x" }, userId: PRIMARY_USER_ID });
    eventLog.append({ type: "extraction_completed", actor: "system", payload: { sourceEventId: upload.id, kind: "document" }, userId: PRIMARY_USER_ID });

    const list = listUploads(eventLog, PRIMARY_USER_ID);
    expect(list).toEqual([{ uploadEventId: upload.id, filename: "notes.pdf", mimeType: "application/pdf", uploadedAt: upload.recordedAt, extractionStatus: "completed" }]);
  });

  it("reports pending when extraction hasn't completed or failed yet", () => {
    const upload = eventLog.append({ type: "file_uploaded", actor: "user", payload: { filename: "notes.pdf", mimeType: "application/pdf", byteLength: 1, path: "x" }, userId: PRIMARY_USER_ID });
    expect(listUploads(eventLog, PRIMARY_USER_ID)[0]!.extractionStatus).toBe("pending");
  });

  it("reports failed when extraction_failed was recorded", () => {
    const upload = eventLog.append({ type: "file_uploaded", actor: "user", payload: { filename: "notes.pdf", mimeType: "application/pdf", byteLength: 1, path: "x" }, userId: PRIMARY_USER_ID });
    eventLog.append({ type: "extraction_failed", actor: "system", payload: { sourceEventId: upload.id, reason: "timeout" }, userId: PRIMARY_USER_ID });
    expect(listUploads(eventLog, PRIMARY_USER_ID)[0]!.extractionStatus).toBe("failed");
  });

  it("excludes a deleted upload — gone from the list the moment it's tombstoned, same mechanism as everywhere else", () => {
    const upload = eventLog.append({ type: "file_uploaded", actor: "user", payload: { filename: "notes.pdf", mimeType: "application/pdf", byteLength: 1, path: "x" }, userId: PRIMARY_USER_ID });
    eventLog.append({ type: "upload_deleted", actor: "user", payload: { uploadEventId: upload.id, filename: "notes.pdf", removedFactCount: 0, preservedFactCount: 0 }, userId: PRIMARY_USER_ID });

    expect(listUploads(eventLog, PRIMARY_USER_ID)).toEqual([]);
  });

  it("scopes strictly to the given user", () => {
    eventLog.append({ type: "file_uploaded", actor: "user", payload: { filename: "someone-elses.pdf", mimeType: "application/pdf", byteLength: 1, path: "x" }, userId: "someone-else" });
    expect(listUploads(eventLog, PRIMARY_USER_ID)).toEqual([]);
  });
});

describe("computeDeletionImpact (the dry-run preview)", () => {
  it("counts a sole-provenance attribute as removed and a corroborated one as preserved", () => {
    const upload = eventLog.append({ type: "file_uploaded", actor: "user", payload: { filename: "notes.pdf", mimeType: "application/pdf", byteLength: 1, path: "x" }, userId: PRIMARY_USER_ID });
    eventLog.append({
      type: "extraction_completed",
      actor: "system",
      payload: { sourceEventId: upload.id, extractorVersion: "attachment-v1", entities: [{ name: "Diego", type: "person" }], attributes: [{ entityName: "Diego", attribute: "location", value: "Boston", eventDate: null }] },
      userId: PRIMARY_USER_ID
    });
    const msg = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "Diego is a teacher." }, userId: PRIMARY_USER_ID });
    eventLog.append({
      type: "extraction_completed",
      actor: "system",
      payload: { sourceEventId: msg.id, extractorVersion: "message-v1", entities: [{ name: "Diego", type: "person" }], attributes: [{ entityName: "Diego", attribute: "occupation", value: "teacher", eventDate: null }] },
      userId: PRIMARY_USER_ID
    });
    rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);

    const impact = computeDeletionImpact(eventLog, projections, PRIMARY_USER_ID, upload.id);
    expect(impact.filename).toBe("notes.pdf");
    // The Boston location's sole provenance is the deleted upload -> removed.
    // The occupation fact has ZERO provenance overlap with this upload at all
    // (a completely separate message) -> unrelated to THIS deletion, counted
    // in neither bucket. A real bug caught live during this feature's own
    // first manual test: this used to be miscounted as "preserved," which
    // falsely implies the file contributed something to a fact it never
    // touched at all.
    expect(impact.removedFactCount).toBe(1);
    expect(impact.preservedFactCount).toBe(0);
  });

  it("counts a fact with genuinely PARTIAL provenance overlap — contributed to by this upload but also independently sourced — as preserved, not removed", () => {
    const upload = eventLog.append({ type: "file_uploaded", actor: "user", payload: { filename: "notes.pdf", mimeType: "application/pdf", byteLength: 1, path: "x" }, userId: PRIMARY_USER_ID });
    const extraction = eventLog.append({ type: "extraction_completed", actor: "system", payload: { sourceEventId: upload.id, extractorVersion: "attachment-v1", entities: [] }, userId: PRIMARY_USER_ID });
    const independentMsg = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "Confirming Diego lives in Boston." }, userId: PRIMARY_USER_ID });
    rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);

    // The current pipeline never actually produces one row spanning two
    // separate sources this way (each assertion is always its own row,
    // narrowly provenanced to the one extraction that produced it — see
    // src/perception/attributes.ts). This directly exercises the
    // CLASSIFIER's "preserved" branch on the row shape EN-066's eventual
    // fact_confirmed-provenance link would need to produce, independent
    // of whether anything upstream builds that shape yet.
    projections.insertEntityAttribute({
      id: "synthetic-partial-provenance-row",
      user_id: PRIMARY_USER_ID,
      entity_id: "primary:test-user",
      attribute: "location",
      value: "Boston",
      source_event_ids: JSON.stringify([extraction.id, independentMsg.id].sort()),
      created_at: new Date().toISOString()
    });

    const impact = computeDeletionImpact(eventLog, projections, PRIMARY_USER_ID, upload.id);
    expect(impact.removedFactCount).toBe(0);
    expect(impact.preservedFactCount).toBe(1);
  });

  it("never mutates anything — a dry run is genuinely read-only", () => {
    const upload = eventLog.append({ type: "file_uploaded", actor: "user", payload: { filename: "notes.pdf", mimeType: "application/pdf", byteLength: 1, path: "x" }, userId: PRIMARY_USER_ID });
    eventLog.append({ type: "extraction_completed", actor: "system", payload: { sourceEventId: upload.id, extractorVersion: "attachment-v1", entities: [{ name: "Diego", type: "person" }] }, userId: PRIMARY_USER_ID });
    rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);

    const beforeEventCount = eventLog.listForUser(PRIMARY_USER_ID).length;
    computeDeletionImpact(eventLog, projections, PRIMARY_USER_ID, upload.id);
    const afterEventCount = eventLog.listForUser(PRIMARY_USER_ID).length;

    expect(afterEventCount).toBe(beforeEventCount); // no tombstone was appended
    expect(projections.listEntities(PRIMARY_USER_ID).map((e) => e.name)).toContain("Diego"); // projection untouched
  });

  it("throws a clear error for an id that isn't a real file_uploaded event", () => {
    const msg = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "not an upload" }, userId: PRIMARY_USER_ID });
    expect(() => computeDeletionImpact(eventLog, projections, PRIMARY_USER_ID, msg.id)).toThrow(/no file_uploaded event/);
  });
});

describe("deleteUpload (the real thing)", () => {
  function deps() {
    return { eventLog, blobStore, projectionsDb: projections, retrievalDb, embedder };
  }

  it("removes the physical file bytes", async () => {
    const stored = blobStore.put(Buffer.from("real file content"), "notes.pdf");
    const upload = eventLog.append({ type: "file_uploaded", actor: "user", payload: { filename: "notes.pdf", mimeType: "application/pdf", byteLength: 18, path: stored.relativePath }, userId: PRIMARY_USER_ID });
    expect(blobStore.exists(stored.relativePath)).toBe(true);

    await deleteUpload(deps(), PRIMARY_USER_ID, upload.id);

    expect(blobStore.exists(stored.relativePath)).toBe(false);
  });

  it("appends an upload_deleted tombstone recording the SAME impact computeDeletionImpact would report, never a separately-computed one", async () => {
    const stored = blobStore.put(Buffer.from("x"), "notes.pdf");
    const upload = eventLog.append({ type: "file_uploaded", actor: "user", payload: { filename: "notes.pdf", mimeType: "application/pdf", byteLength: 1, path: stored.relativePath }, userId: PRIMARY_USER_ID });
    eventLog.append({ type: "extraction_completed", actor: "system", payload: { sourceEventId: upload.id, extractorVersion: "attachment-v1", entities: [{ name: "Diego", type: "person" }], attributes: [{ entityName: "Diego", attribute: "location", value: "Boston", eventDate: null }] }, userId: PRIMARY_USER_ID });
    rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);
    const previewedImpact: DeletionImpact = computeDeletionImpact(eventLog, projections, PRIMARY_USER_ID, upload.id);

    const { tombstoneEvent, impact } = await deleteUpload(deps(), PRIMARY_USER_ID, upload.id);

    expect(impact).toEqual(previewedImpact);
    const payload = tombstoneEvent.payload as UploadDeletedPayload;
    expect(payload.uploadEventId).toBe(upload.id);
    expect(payload.filename).toBe("notes.pdf");
    expect(payload.removedFactCount).toBe(previewedImpact.removedFactCount);
    expect(payload.preservedFactCount).toBe(previewedImpact.preservedFactCount);
  });

  it("takes effect immediately — projections and retrieval are rebuilt as part of deletion, not deferred to the next chat turn", async () => {
    const stored = blobStore.put(Buffer.from("x"), "notes.pdf");
    const upload = eventLog.append({ type: "file_uploaded", actor: "user", payload: { filename: "notes.pdf", mimeType: "application/pdf", byteLength: 1, path: stored.relativePath }, userId: PRIMARY_USER_ID });
    eventLog.append({ type: "extraction_completed", actor: "system", payload: { sourceEventId: upload.id, kind: "document", fullText: "Diego's plan.", entities: [{ name: "Diego", type: "person" }] }, userId: PRIMARY_USER_ID });
    rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);
    expect(projections.listEntities(PRIMARY_USER_ID).map((e) => e.name)).toContain("Diego");

    await deleteUpload(deps(), PRIMARY_USER_ID, upload.id);

    // No further rebuild call here — deleteUpload's own internal rebuild is what this checks.
    expect(projections.listEntities(PRIMARY_USER_ID).map((e) => e.name)).not.toContain("Diego");
    expect(retrievalDb.getChunksBySourceEventId(upload.id)).toHaveLength(0);
  });
});
