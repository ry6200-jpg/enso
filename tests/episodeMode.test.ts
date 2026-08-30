import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/events/eventLog.js";
import { ProjectionsDb } from "../src/projections/db.js";
import { rebuildProjections } from "../src/projections/rebuild.js";
import { RetrievalDb } from "../src/retrieval/retrievalDb.js";
import { rebuildRetrievalIndex } from "../src/retrieval/rebuildRetrievalIndex.js";
import { episodeMode } from "../src/retrieval/episodeMode.js";
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
    payload: { sourceEventId, extractorVersion: "message-v1", entities: [], structuralAtoms: [], socialBonds: [], attributes: [], episodeMarkers: [], ...payload },
    userId: PRIMARY_USER_ID
  });
}

describe("episodeMode (EN-037, Phase 8.5: wired to the real clustering projection)", () => {
  it("returns the bounded raw source messages for a clustered episode, never a summary", async () => {
    const msg1 = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "So this whole thing with my sister started last week." }, userId: PRIMARY_USER_ID });
    appendExtraction(msg1.id, { episodeMarkers: [{ kind: "boundary_start", text: "A falling out with my sister began." }] });
    const msg2 = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "She still hasn't called me back." }, userId: PRIMARY_USER_ID });
    appendExtraction(msg2.id, { episodeMarkers: [{ kind: "incident_reference", text: "Still no call back." }] });
    const msg3 = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "We finally talked and made up." }, userId: PRIMARY_USER_ID });
    appendExtraction(msg3.id, { episodeMarkers: [{ kind: "boundary_end", text: "We made up." }] });

    rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);
    await rebuildRetrievalIndex(eventLog.listForUser(PRIMARY_USER_ID), retrievalDb, PRIMARY_USER_ID, embedder);

    const episode = projections.listEpisodesByNarrativeOrder(PRIMARY_USER_ID)[0]!;
    const match = episodeMode(projections, retrievalDb, PRIMARY_USER_ID, episode.id)!;

    expect(match.title).toBe("A falling out with my sister began.");
    const texts = match.chunks.map((c) => c.text);
    expect(texts).toContain("So this whole thing with my sister started last week.");
    expect(texts).toContain("She still hasn't called me back.");
    expect(texts).toContain("We finally talked and made up.");
  });

  it("returns undefined for an unknown or cross-user episode id", () => {
    expect(episodeMode(projections, retrievalDb, PRIMARY_USER_ID, "not-a-real-id")).toBeUndefined();
  });
});
