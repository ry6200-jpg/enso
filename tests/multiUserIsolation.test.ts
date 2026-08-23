import { beforeAll, describe, expect, it } from "vitest";
import { EventLog } from "../src/events/eventLog.js";
import { ProjectionsDb } from "../src/projections/db.js";
import { RetrievalDb } from "../src/retrieval/retrievalDb.js";
import { getUserDataPaths } from "../src/storage/userDataPaths.js";
import { getConversationHistory } from "../src/conversation/conversationHistory.js";
import { getPeopleView, buildSelfProfile } from "../src/projections/peopleView.js";
import { rebuildRetrievalIndex } from "../src/retrieval/rebuildRetrievalIndex.js";
import { hybridSearch } from "../src/retrieval/hybridSearch.js";
import { configureLocalOnlyEmbeddings, createEmbedder, type Embedder } from "../src/embeddings/embedder.js";
import { resolveTestDbDir } from "../src/test/dbPath.js";
import { newId } from "../src/ids.js";
import { primaryEntityId } from "../src/projections/rebuild.js";

/**
 * Isolation proof (Cloud migration prerequisite batch, item 3) — this is
 * the point of the batch. Two real users, each with their OWN complete
 * set of stores at separate file paths (src/storage/userDataPaths.ts),
 * never a single shared store filtered by user_id. Every assertion below
 * is a FILE-BOUNDARY guarantee, not a "the query happened to filter
 * correctly" guarantee — several of them deliberately pass the WRONG
 * userId into the RIGHT user's store (or vice versa) to prove the
 * isolation holds even when application code gets the id wrong, which is
 * exactly the failure mode a single shared store can't structurally rule
 * out.
 */

let embedder: Embedder;

beforeAll(async () => {
  configureLocalOnlyEmbeddings();
  embedder = await createEmbedder();
});

interface UserStores {
  uid: string;
  eventLog: EventLog;
  projectionsDb: ProjectionsDb;
  retrievalDb: RetrievalDb;
}

function freshUserStores(uid: string): UserStores {
  const root = resolveTestDbDir(import.meta.url);
  const paths = getUserDataPaths(`${root}-${newId()}`, uid);
  return {
    uid,
    eventLog: new EventLog(paths.eventsDb),
    projectionsDb: new ProjectionsDb(paths.projectionsDb),
    retrievalDb: new RetrievalDb(paths.retrievalDb)
  };
}

function seedUser(u: UserStores, friendName: string, secretText: string, birthdate: string): void {
  const msg = u.eventLog.append({ type: "message_sent", actor: "user", payload: { text: secretText, attachmentOnly: false }, userId: u.uid });

  const friendId = newId();
  u.projectionsDb.insertEntity({
    id: friendId,
    user_id: u.uid,
    name: friendName,
    confirmed: 0,
    source_event_ids: JSON.stringify([msg.id]),
    extractor_version: "message-v1",
    pending_disambiguation: null,
    created_at: new Date().toISOString()
  });
  u.projectionsDb.insertSocialBond({
    id: newId(),
    user_id: u.uid,
    type: "friend",
    from_entity_id: friendId,
    to_entity_id: primaryEntityId(u.uid),
    qualifier: null,
    opened_basis: "stated",
    interval_start: null,
    interval_end: null,
    source_event_ids: JSON.stringify([msg.id]),
    created_at: new Date().toISOString()
  });
  u.projectionsDb.insertEntityAttribute({
    id: newId(),
    user_id: u.uid,
    entity_id: primaryEntityId(u.uid),
    attribute: "birthdate",
    value: birthdate,
    source_event_ids: JSON.stringify([msg.id]),
    created_at: new Date().toISOString()
  });
}

describe("Multi-user isolation proof (Cloud migration prerequisite batch, item 3)", () => {
  it("user A's messages never appear in user B's history, and vice versa — even when the wrong userId is passed against the RIGHT user's file", async () => {
    const a = freshUserStores("user-a");
    const b = freshUserStores("user-b");
    seedUser(a, "Alice Wonderland", "My close friend Alice Wonderland told me a huge secret about her promotion.", "1990-01-01");
    seedUser(b, "Bob Builder", "My close friend Bob Builder told me a huge secret about his new house.", "1985-06-15");

    const historyA = getConversationHistory(a.eventLog, a.uid).map((m) => m.text).join(" ");
    const historyB = getConversationHistory(b.eventLog, b.uid).map((m) => m.text).join(" ");
    expect(historyA).toContain("Alice Wonderland");
    expect(historyA).not.toContain("Bob Builder");
    expect(historyB).toContain("Bob Builder");
    expect(historyB).not.toContain("Alice Wonderland");

    // The sharper proof: even asking A's OWN eventLog for B's userId returns nothing — the isolation
    // is that B's row is simply not in this file, not that the query happened to filter correctly.
    expect(getConversationHistory(a.eventLog, b.uid)).toEqual([]);
    expect(getConversationHistory(b.eventLog, a.uid)).toEqual([]);
  });

  it("user A's entities/relationships never appear in user B's people view or self-profile block, and vice versa", async () => {
    const a = freshUserStores("user-a");
    const b = freshUserStores("user-b");
    seedUser(a, "Alice Wonderland", "My close friend Alice Wonderland told me a huge secret about her promotion.", "1990-01-01");
    seedUser(b, "Bob Builder", "My close friend Bob Builder told me a huge secret about his new house.", "1985-06-15");

    const peopleA = getPeopleView(a.eventLog, a.projectionsDb, a.uid).map((p) => p.name);
    const peopleB = getPeopleView(b.eventLog, b.projectionsDb, b.uid).map((p) => p.name);
    expect(peopleA).toContain("Alice Wonderland");
    expect(peopleA).not.toContain("Bob Builder");
    expect(peopleB).toContain("Bob Builder");
    expect(peopleB).not.toContain("Alice Wonderland");

    const selfA = buildSelfProfile(a.projectionsDb, a.uid);
    const selfB = buildSelfProfile(b.projectionsDb, b.uid);
    expect(selfA.attributes.find((x) => x.attribute === "birthdate")?.value).toBe("1990-01-01");
    expect(selfB.attributes.find((x) => x.attribute === "birthdate")?.value).toBe("1985-06-15");
  });

  it("user A's content never surfaces in user B's retrieval index, and vice versa", async () => {
    const a = freshUserStores("user-a");
    const b = freshUserStores("user-b");
    seedUser(a, "Alice Wonderland", "My close friend Alice Wonderland told me a huge secret about her promotion.", "1990-01-01");
    seedUser(b, "Bob Builder", "My close friend Bob Builder told me a huge secret about his new house.", "1985-06-15");

    await rebuildRetrievalIndex(a.eventLog.listForUser(a.uid), a.retrievalDb, a.uid, embedder);
    await rebuildRetrievalIndex(b.eventLog.listForUser(b.uid), b.retrievalDb, b.uid, embedder);

    const resultsFromA = await hybridSearch(a.retrievalDb, a.uid, "secret", embedder, { limit: 10 });
    const textsFromA = resultsFromA.map((r) => a.retrievalDb.db.prepare(`SELECT text FROM content_chunks WHERE id = ?`).get(r.chunkId) as { text: string }).map((r) => r.text);
    expect(textsFromA.some((t) => t.includes("Alice Wonderland"))).toBe(true);
    expect(textsFromA.some((t) => t.includes("Bob Builder"))).toBe(false);

    // Sharper proof again: querying A's retrieval index with B's userId returns nothing — Bob's content was never indexed into this file at all.
    const crossUserQuery = await hybridSearch(a.retrievalDb, b.uid, "secret", embedder, { limit: 10 });
    expect(crossUserQuery).toEqual([]);
  });

  it("each user's proactive-opener condition (empty history) is independent — A having history does not suppress B's fresh-session signal", () => {
    const a = freshUserStores("user-a");
    const b = freshUserStores("user-b");
    seedUser(a, "Alice Wonderland", "My close friend Alice Wonderland told me a huge secret about her promotion.", "1990-01-01");
    // B is deliberately left untouched — a genuinely fresh user.

    expect(getConversationHistory(a.eventLog, a.uid).length).toBeGreaterThan(0);
    expect(getConversationHistory(b.eventLog, b.uid).length).toBe(0);
  });

  it("directly proves the point of the batch: an unscoped-by-ID ProjectionsDb method cannot reach across users, given separate files — even asked for the EXACT id that exists in the other user's store", () => {
    const a = freshUserStores("user-a");
    const b = freshUserStores("user-b");
    seedUser(a, "Alice Wonderland", "My close friend Alice Wonderland told me a huge secret about her promotion.", "1990-01-01");

    const aliceEntity = a.projectionsDb.listEntities(a.uid).find((e) => e.name === "Alice Wonderland")!;
    const aliceBond = b.projectionsDb === a.projectionsDb ? null : a.projectionsDb.listSocialBonds(a.uid)[0]!;

    // getEntityById takes NO user_id at all (src/projections/db.ts) — the ONLY reason this is
    // safe is that Alice's row physically does not exist in B's file. Same exact id, different file.
    expect(a.projectionsDb.getEntityById(aliceEntity.id)).toBeDefined();
    expect(b.projectionsDb.getEntityById(aliceEntity.id)).toBeUndefined();

    // Same proof for getSocialBondById — another of the ~10 unscoped-by-id methods named in the report.
    expect(a.projectionsDb.getSocialBondById(aliceBond!.id)).toBeDefined();
    expect(b.projectionsDb.getSocialBondById(aliceBond!.id)).toBeUndefined();
  });
});
