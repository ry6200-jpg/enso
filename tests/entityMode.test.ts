import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/events/eventLog.js";
import { ProjectionsDb } from "../src/projections/db.js";
import { rebuildProjections } from "../src/projections/rebuild.js";
import { RetrievalDb } from "../src/retrieval/retrievalDb.js";
import { rebuildRetrievalIndex } from "../src/retrieval/rebuildRetrievalIndex.js";
import { entityMode } from "../src/retrieval/entityMode.js";
import { configureLocalOnlyEmbeddings, createEmbedder, type Embedder } from "../src/embeddings/embedder.js";
import { freshTestDbPath } from "../src/test/dbPath.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";

let eventLog: EventLog;
let projections: ProjectionsDb;
let retrievalDb: RetrievalDb;
let embedder: Embedder;

beforeAll(async () => {
  configureLocalOnlyEmbeddings();
  embedder = await createEmbedder();
});

beforeEach(() => {
  eventLog = new EventLog(freshTestDbPath(import.meta.url, "events"));
  projections = new ProjectionsDb(freshTestDbPath(import.meta.url, "projections"));
  retrievalDb = new RetrievalDb(freshTestDbPath(import.meta.url, "retrieval"));
});

function appendExtraction(sourceEventId: string, payload: Record<string, unknown>) {
  return eventLog.append({
    type: "extraction_completed",
    actor: "system",
    payload: { sourceEventId, extractorVersion: "message-v1", entities: [], structuralAtoms: [], socialBonds: [], attributes: [], knownPeopleNames: [], ...payload },
    userId: PRIMARY_USER_ID
  });
}

describe("entityMode (EN-035): messages linked to a person via provenance, even when the name isn't literal text", () => {
  it("finds a message referring to a known person only by role ('my mom'), not by name", async () => {
    // Establish "Elena" by name first.
    const msg1 = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "My mom is named Elena." }, userId: PRIMARY_USER_ID });
    appendExtraction(msg1.id, { entities: [{ name: "Elena", type: "person" }], structuralAtoms: [{ type: "parent_of", fromName: "Elena", toName: "me", action: "assert", explicitlyNewPerson: false }] });

    // A LATER message that mentions her only via the kinship term "mom" —
    // the extractor, given knownPeopleNames including Elena, would
    // normally substitute the real name (Part 2/3), but this test proves
    // entityMode itself works purely off provenance regardless of how the
    // name got resolved: simulate the resolved-name case directly.
    const msg2 = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "My mom called about dinner plans tonight." }, userId: PRIMARY_USER_ID });
    appendExtraction(msg2.id, { entities: [{ name: "Elena", type: "person" }] }); // extractor substituted the known name, per EN-012's known-people injection

    // An unrelated message that should NOT show up.
    const msg3 = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "Lunch with a coworker today." }, userId: PRIMARY_USER_ID });
    appendExtraction(msg3.id, { entities: [{ name: "Priya", type: "person" }] });

    rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);
    await rebuildRetrievalIndex(eventLog.listForUser(PRIMARY_USER_ID), retrievalDb, PRIMARY_USER_ID, embedder);

    const elena = projections.listEntities(PRIMARY_USER_ID).find((e) => e.name === "Elena")!;
    const results = entityMode(projections, retrievalDb, PRIMARY_USER_ID, elena.id);

    const texts = results.map((r) => r.text);
    expect(texts).toContain("My mom is named Elena.");
    expect(texts).toContain("My mom called about dinner plans tonight."); // linked via provenance, "Elena" never appears literally in this text
    expect(texts).not.toContain("Lunch with a coworker today.");
  });

  it("returns raw text, not a summary, for every linked message", async () => {
    const msg = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "Priya helped me today." }, userId: PRIMARY_USER_ID });
    appendExtraction(msg.id, { entities: [{ name: "Priya", type: "person" }] });

    rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);
    await rebuildRetrievalIndex(eventLog.listForUser(PRIMARY_USER_ID), retrievalDb, PRIMARY_USER_ID, embedder);

    const priya = projections.listEntities(PRIMARY_USER_ID).find((e) => e.name === "Priya")!;
    const results = entityMode(projections, retrievalDb, PRIMARY_USER_ID, priya.id);
    expect(results[0]!.text).toBe("Priya helped me today.");
  });

  it("returns an empty array for an unknown or cross-user entity id", () => {
    expect(entityMode(projections, retrievalDb, PRIMARY_USER_ID, "not-a-real-id")).toEqual([]);
  });
});
