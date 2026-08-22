import { beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/events/eventLog.js";
import { ProjectionsDb } from "../src/projections/db.js";
import { rebuildProjections } from "../src/projections/rebuild.js";
import { compareExact, exactRowsFromEntityRows } from "../src/comparator/structuralEquivalence.js";
import { freshTestDbPath } from "../src/test/dbPath.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";

let eventLog: EventLog;
let projections: ProjectionsDb;

beforeEach(() => {
  eventLog = new EventLog(freshTestDbPath(import.meta.url, "events"));
  projections = new ProjectionsDb(freshTestDbPath(import.meta.url, "projections"));
});

function seedScenario() {
  const msg1 = eventLog.append({
    type: "message_sent",
    actor: "user",
    payload: { text: "I had lunch with Sarah and my sister Amy today." },
    userId: PRIMARY_USER_ID
  });
  // Real Phase 2 shape: extraction_completed payload already carries the
  // final entities directly — nothing about rebuild re-derives this.
  const extraction1 = eventLog.append({
    type: "extraction_completed",
    actor: "system",
    payload: {
      sourceEventId: msg1.id,
      extractorVersion: "message-v1",
      provider: "openai",
      model: "gpt-5.6-terra",
      entities: [{ name: "Sarah", type: "person" }, { name: "Amy", type: "person" }]
    },
    userId: PRIMARY_USER_ID
  });
  const msg2 = eventLog.append({
    type: "message_sent",
    actor: "user",
    payload: { text: "Tried calling Priya but it timed out." },
    userId: PRIMARY_USER_ID
  });
  eventLog.append({
    type: "extraction_failed",
    actor: "system",
    payload: { sourceEventId: msg2.id, reason: "timeout" },
    userId: PRIMARY_USER_ID
  });
  eventLog.append({
    type: "fact_corrected",
    actor: "user",
    payload: { targetEventId: extraction1.id, entityName: "Amy", correctedName: "Amelia" },
    userId: PRIMARY_USER_ID
  });
  eventLog.append({
    type: "fact_confirmed",
    actor: "user",
    payload: { targetEventId: extraction1.id, entityName: "Sarah" },
    userId: PRIMARY_USER_ID
  });
  return { msg1, extraction1, msg2 };
}

describe("rebuildProjections (EN-054 v1.5 — payload-reading, no extraction)", () => {
  it("drops existing projection rows before replaying (rebuild is not additive)", () => {
    projections.insertEntity({
      id: "01STRAY00000000000000000",
      user_id: PRIMARY_USER_ID,
      name: "StaleGhost",
      confirmed: 0,
      source_event_ids: "[]",
      extractor_version: "old-version",
      pending_disambiguation: null,
      created_at: new Date().toISOString()
    });

    seedScenario();
    rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);

    const names = projections.listEntities(PRIMARY_USER_ID).map((e) => e.name);
    expect(names).not.toContain("StaleGhost");
  });

  it("reads entities directly from the recorded extraction_completed payload — no extraction runs", () => {
    const { msg1, extraction1 } = seedScenario();
    const result = rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);

    // Note: rebuildProjections takes no extractor function at all anymore —
    // there is no code path here that could call a provider. This count is
    // "how many recorded extraction_completed events were consumed," not
    // "how many extractions ran."
    expect(result.extractionsConsumed).toBe(1); // only msg1 has one
    expect(result.messagesCurrentlyFailed).toBe(1); // msg2's extraction_failed, still unresolved

    const sarah = projections.listEntities(PRIMARY_USER_ID).find((e) => e.name === "Sarah")!;
    expect(sarah).toBeDefined();
    expect(sarah.extractor_version).toBe("message-v1");
    expect(JSON.parse(sarah.source_event_ids)).toEqual(
      expect.arrayContaining([msg1.id, extraction1.id])
    );
  });

  it("a message that failed then later succeeded is not counted as currently failed (latest-event-wins)", () => {
    const msg = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "Eventually works." }, userId: PRIMARY_USER_ID });
    eventLog.append({ type: "extraction_failed", actor: "user", payload: { sourceEventId: msg.id, reason: "timeout" }, userId: PRIMARY_USER_ID });
    eventLog.append({
      type: "extraction_completed",
      actor: "system",
      payload: { sourceEventId: msg.id, extractorVersion: "message-v1", entities: [] },
      userId: PRIMARY_USER_ID
    });

    const result = rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);
    expect(result.messagesCurrentlyFailed).toBe(0);
  });

  it("applies fact_corrected with precedence over extraction output, bound to the event ULID (EN-055)", () => {
    seedScenario();
    const result = rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);

    expect(result.correctionsApplied).toBe(1);
    const names = projections.listEntities(PRIMARY_USER_ID).map((e) => e.name);
    expect(names).toContain("Amelia");
    expect(names).not.toContain("Amy");
  });

  it("applies fact_confirmed as an attestation flag bound to the event ULID", () => {
    seedScenario();
    rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);

    const sarah = projections.listEntities(PRIMARY_USER_ID).find((e) => e.name === "Sarah")!;
    expect(sarah.confirmed).toBe(1);
    const amelia = projections.listEntities(PRIMARY_USER_ID).find((e) => e.name === "Amelia")!;
    expect(amelia.confirmed).toBe(0);
  });

  it("a rebuild never resurrects a name the user already corrected away (EN-055 launch-blocking guarantee)", () => {
    seedScenario();
    rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);
    rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);

    const names = projections.listEntities(PRIMARY_USER_ID).map((e) => e.name);
    expect(names).not.toContain("Amy");
    expect(names).toContain("Amelia");
  });

  it("is deterministic: two independent rebuilds of the same log match EXACTLY, no tolerance (EN-057 v1.5)", () => {
    seedScenario();
    const events = eventLog.listForUser(PRIMARY_USER_ID);

    const projectionsB = new ProjectionsDb(freshTestDbPath(import.meta.url, "projections-b"));

    rebuildProjections(events, projections, PRIMARY_USER_ID);
    rebuildProjections(events, projectionsB, PRIMARY_USER_ID);

    const rowsA = exactRowsFromEntityRows(projections.listEntities(PRIMARY_USER_ID));
    const rowsB = exactRowsFromEntityRows(projectionsB.listEntities(PRIMARY_USER_ID));

    expect(compareExact(rowsA, rowsB)).toEqual({ equivalent: true, differences: [] });
  });

  it("strict-exact comparison catches a planted difference that tolerant comparison would also catch", () => {
    seedScenario();
    const events = eventLog.listForUser(PRIMARY_USER_ID);
    rebuildProjections(events, projections, PRIMARY_USER_ID);

    const rowsA = exactRowsFromEntityRows(projections.listEntities(PRIMARY_USER_ID));
    const mutated = rowsA.filter((r) => r.name.toLowerCase() !== "amelia");

    const comparison = compareExact(rowsA, mutated);
    expect(comparison.equivalent).toBe(false);
    expect(comparison.differences.some((d) => d.includes("Amelia"))).toBe(true);
  });

  it("strict-exact comparison catches a difference tolerant comparison would ignore (casing, provenance)", () => {
    const rowsA = [{ name: "Sarah", confirmed: false, sourceEventIds: ["a", "b"], extractorVersion: "message-v1" }];
    const rowsB = [{ name: "sarah", confirmed: false, sourceEventIds: ["a", "b"], extractorVersion: "message-v1" }]; // different case only

    // compareStructural (tolerant) would call these equivalent; compareExact must not.
    const comparison = compareExact(rowsA, rowsB);
    expect(comparison.equivalent).toBe(false);
  });
});

describe("rebuildProjections + upload deletion (EN-065)", () => {
  it("a fact whose SOLE provenance is a deleted upload's extraction is not recreated on rebuild", () => {
    const upload = eventLog.append({ type: "file_uploaded", actor: "user", payload: { filename: "notes.pdf", mimeType: "application/pdf", byteLength: 1, path: "x" }, userId: PRIMARY_USER_ID });
    eventLog.append({
      type: "extraction_completed",
      actor: "system",
      payload: { sourceEventId: upload.id, extractorVersion: "attachment-v1", entities: [{ name: "Diego", type: "person" }] },
      userId: PRIMARY_USER_ID
    });

    rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);
    expect(projections.listEntities(PRIMARY_USER_ID).map((e) => e.name)).toContain("Diego");

    eventLog.append({ type: "upload_deleted", actor: "user", payload: { uploadEventId: upload.id, filename: "notes.pdf", removedFactCount: 0, preservedFactCount: 0 }, userId: PRIMARY_USER_ID });
    rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);

    expect(projections.listEntities(PRIMARY_USER_ID).map((e) => e.name)).not.toContain("Diego");
  });

  it("an entity mentioned in BOTH a deleted upload and a separate message survives — only the eclipsed extraction is skipped", () => {
    const upload = eventLog.append({ type: "file_uploaded", actor: "user", payload: { filename: "notes.pdf", mimeType: "application/pdf", byteLength: 1, path: "x" }, userId: PRIMARY_USER_ID });
    eventLog.append({
      type: "extraction_completed",
      actor: "system",
      payload: { sourceEventId: upload.id, extractorVersion: "attachment-v1", entities: [{ name: "Diego", type: "person" }] },
      userId: PRIMARY_USER_ID
    });
    const msg = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "Diego called today." }, userId: PRIMARY_USER_ID });
    eventLog.append({
      type: "extraction_completed",
      actor: "system",
      payload: { sourceEventId: msg.id, extractorVersion: "message-v1", entities: [{ name: "Diego", type: "person" }] },
      userId: PRIMARY_USER_ID
    });
    eventLog.append({ type: "upload_deleted", actor: "user", payload: { uploadEventId: upload.id, filename: "notes.pdf", removedFactCount: 0, preservedFactCount: 0 }, userId: PRIMARY_USER_ID });

    rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);

    expect(projections.listEntities(PRIMARY_USER_ID).map((e) => e.name)).toContain("Diego");
  });

  it("an attribute whose sole provenance is a deleted upload is not recreated, while one corroborated by a later message is", () => {
    const upload = eventLog.append({ type: "file_uploaded", actor: "user", payload: { filename: "notes.pdf", mimeType: "application/pdf", byteLength: 1, path: "x" }, userId: PRIMARY_USER_ID });
    eventLog.append({
      type: "extraction_completed",
      actor: "system",
      payload: { sourceEventId: upload.id, extractorVersion: "attachment-v1", entities: [{ name: "Diego", type: "person" }], attributes: [{ entityName: "Diego", attribute: "location", value: "Boston", eventDate: null }] },
      userId: PRIMARY_USER_ID
    });
    const msg = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "Diego lives in Boston." }, userId: PRIMARY_USER_ID });
    eventLog.append({
      type: "extraction_completed",
      actor: "system",
      payload: { sourceEventId: msg.id, extractorVersion: "message-v1", entities: [{ name: "Diego", type: "person" }], attributes: [{ entityName: "Diego", attribute: "occupation", value: "teacher", eventDate: null }] },
      userId: PRIMARY_USER_ID
    });
    eventLog.append({ type: "upload_deleted", actor: "user", payload: { uploadEventId: upload.id, filename: "notes.pdf", removedFactCount: 0, preservedFactCount: 0 }, userId: PRIMARY_USER_ID });

    rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);

    const attrs = projections.listAllEntityAttributes(PRIMARY_USER_ID);
    expect(attrs.some((a) => a.attribute === "location" && a.value === "Boston")).toBe(false); // sole provenance was the deleted upload
    expect(attrs.some((a) => a.attribute === "occupation" && a.value === "teacher")).toBe(true); // from the surviving message
  });

  it("extractionsConsumed does not count an eclipsed extraction_completed event", () => {
    const upload = eventLog.append({ type: "file_uploaded", actor: "user", payload: { filename: "notes.pdf", mimeType: "application/pdf", byteLength: 1, path: "x" }, userId: PRIMARY_USER_ID });
    eventLog.append({ type: "extraction_completed", actor: "system", payload: { sourceEventId: upload.id, extractorVersion: "attachment-v1", entities: [] }, userId: PRIMARY_USER_ID });
    eventLog.append({ type: "upload_deleted", actor: "user", payload: { uploadEventId: upload.id, filename: "notes.pdf", removedFactCount: 0, preservedFactCount: 0 }, userId: PRIMARY_USER_ID });

    const result = rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);
    expect(result.extractionsConsumed).toBe(0);
  });

  it("rebuild with no upload_deleted events at all is completely unaffected (the common case)", () => {
    seedScenario();
    const before = rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);
    expect(before.entitiesWritten).toBeGreaterThan(0);
  });
});
