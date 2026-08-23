import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withUserSession } from "../src/storage/userSession.js";
import { EventLog } from "../src/events/eventLog.js";
import { LocalStorageBackend } from "../src/storage/localStorageBackend.js";
import { LockAcquisitionError } from "../src/storage/userStorageBackend.js";
import { rebuildProjections } from "../src/projections/rebuild.js";
import { compareExact, exactRowsFromEntityRows } from "../src/comparator/structuralEquivalence.js";
import { EMBEDDING_DIMENSIONS } from "../src/embeddings/embedder.js";
import { newId } from "../src/ids.js";
import { resolveTestDbDir } from "../src/test/dbPath.js";

function freshRoot(name: string): string {
  const root = resolveTestDbDir(import.meta.url);
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, `${name}-`));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fixedEmbedding(seed: number): Float32Array {
  const v = new Float32Array(EMBEDDING_DIMENSIONS);
  for (let i = 0; i < v.length; i++) v[i] = Math.sin(seed + i);
  return v;
}

describe("withUserSession — checkout/checkin round trip", () => {
  it("round-trips events, projections, retrieval (FTS5 + sqlite-vec), and a blob byte-identically", async () => {
    const remoteRoot = freshRoot("remote");
    const localRoot = freshRoot("local");
    const backend = new LocalStorageBackend(remoteRoot);
    const uid = "user-a";

    const embedding = fixedEmbedding(1);
    let chunkId = "";
    let blobRelativePath = "";

    await withUserSession(backend, localRoot, uid, 30_000, async ({ eventLog, projectionsDb, retrievalDb, blobStore }) => {
      const msg = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "My friend Priya visited.", attachmentOnly: false }, userId: uid });
      eventLog.append({
        type: "extraction_completed",
        actor: "system",
        payload: { sourceEventId: msg.id, extractorVersion: "message-v1", provider: "openai", model: "gpt-5.6-terra", entities: [{ name: "Priya", type: "person" }] },
        userId: uid
      });
      rebuildProjections(eventLog.listForUser(uid), projectionsDb, uid);

      chunkId = newId();
      retrievalDb.insertChunk(
        {
          id: chunkId,
          user_id: uid,
          source_type: "message",
          source_event_id: msg.id,
          extraction_event_id: null,
          chunk_index: 0,
          char_start: 0,
          char_end: "My friend Priya visited.".length,
          text: "My friend Priya visited.",
          occurred_at: null,
          recorded_at: msg.recordedAt,
          created_at: new Date().toISOString()
        },
        embedding
      );

      blobRelativePath = blobStore.put(Buffer.from([9, 8, 7, 6, 5]), "photo.png").relativePath;
    });

    // Fresh checkout — a brand new local directory, nothing carried over in memory.
    const secondLocalRoot = freshRoot("local-2");
    await withUserSession(backend, secondLocalRoot, uid, 30_000, async ({ eventLog, projectionsDb, retrievalDb, blobStore }) => {
      const events = eventLog.listForUser(uid);
      expect(events).toHaveLength(2);
      expect((events[0]!.payload as { text: string }).text).toBe("My friend Priya visited.");

      rebuildProjections(events, projectionsDb, uid);
      const entities = projectionsDb.listEntities(uid);
      expect(entities.map((e) => e.name)).toEqual(["Priya"]); // ids are reassigned on every rebuild (EN-054) — the name is the byte-round-trip-relevant fact here, not entity id stability

      const chunk = retrievalDb.getChunkById(chunkId);
      expect(chunk).toBeDefined();
      expect(chunk!.text).toBe("My friend Priya visited.");

      // FTS5 unaffected by the round trip.
      const ftsHit = retrievalDb.db.prepare(`SELECT rowid FROM content_fts WHERE content_fts MATCH 'Priya'`).all();
      expect(ftsHit).toHaveLength(1);

      // sqlite-vec unaffected: the embedding read back is byte-identical.
      const roundTrippedEmbedding = retrievalDb.getEmbeddingForChunk(chunkId)!;
      expect(Array.from(roundTrippedEmbedding)).toEqual(Array.from(embedding));

      // The blob round-trips byte-identically through remote storage.
      expect(blobStore.exists(blobRelativePath)).toBe(true);
      expect(blobStore.get(blobRelativePath)).toEqual(Buffer.from([9, 8, 7, 6, 5]));
    });
  });

  it("strict-exact rebuild (EN-057) still passes after a round trip: rebuilding twice from the round-tripped log produces byte-identical entity rows", async () => {
    const remoteRoot = freshRoot("remote");
    const localRoot = freshRoot("local");
    const backend = new LocalStorageBackend(remoteRoot);
    const uid = "user-a";

    await withUserSession(backend, localRoot, uid, 30_000, async ({ eventLog, projectionsDb }) => {
      const msg = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "My sister Amy called.", attachmentOnly: false }, userId: uid });
      eventLog.append({
        type: "extraction_completed",
        actor: "system",
        payload: { sourceEventId: msg.id, extractorVersion: "message-v1", provider: "openai", model: "gpt-5.6-terra", entities: [{ name: "Amy", type: "person" }] },
        userId: uid
      });
      rebuildProjections(eventLog.listForUser(uid), projectionsDb, uid);
    });

    const local2 = freshRoot("local-2");
    let rowsAfterFirstCheckout: ReturnType<typeof exactRowsFromEntityRows> = [];
    await withUserSession(backend, local2, uid, 30_000, async ({ eventLog, projectionsDb }) => {
      rebuildProjections(eventLog.listForUser(uid), projectionsDb, uid);
      rowsAfterFirstCheckout = exactRowsFromEntityRows(projectionsDb.listEntities(uid));
    });

    const local3 = freshRoot("local-3");
    let rowsAfterSecondCheckout: ReturnType<typeof exactRowsFromEntityRows> = [];
    await withUserSession(backend, local3, uid, 30_000, async ({ eventLog, projectionsDb }) => {
      rebuildProjections(eventLog.listForUser(uid), projectionsDb, uid);
      rowsAfterSecondCheckout = exactRowsFromEntityRows(projectionsDb.listEntities(uid));
    });

    const comparison = compareExact(rowsAfterFirstCheckout, rowsAfterSecondCheckout);
    expect(comparison.equivalent).toBe(true);
    expect(comparison.differences).toEqual([]);
  });

  it("a second checkout for the same user while the lock is held fails loudly", async () => {
    const remoteRoot = freshRoot("remote");
    const backend = new LocalStorageBackend(remoteRoot);
    const uid = "user-a";

    let releaseFirst!: () => void;
    const holdUntil = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withUserSession(backend, freshRoot("local-1"), uid, 30_000, async () => {
      await holdUntil; // stay checked out until the second attempt has run
    });

    await sleep(20); // let the first call actually acquire the lock before racing the second

    await expect(withUserSession(backend, freshRoot("local-2"), uid, 30_000, async () => {})).rejects.toBeInstanceOf(LockAcquisitionError);

    releaseFirst();
    await first;
  });

  it("two different users check out concurrently without interfering", async () => {
    const remoteRoot = freshRoot("remote");
    const backend = new LocalStorageBackend(remoteRoot);

    await Promise.all([
      withUserSession(backend, freshRoot("local-a"), "user-a", 30_000, async ({ eventLog }) => {
        eventLog.append({ type: "message_sent", actor: "user", payload: { text: "A's secret", attachmentOnly: false }, userId: "user-a" });
      }),
      withUserSession(backend, freshRoot("local-b"), "user-b", 30_000, async ({ eventLog }) => {
        eventLog.append({ type: "message_sent", actor: "user", payload: { text: "B's secret", attachmentOnly: false }, userId: "user-b" });
      })
    ]);

    await withUserSession(backend, freshRoot("readback-a"), "user-a", 30_000, async ({ eventLog }) => {
      const texts = eventLog.listForUser("user-a").map((e) => (e.payload as { text: string }).text);
      expect(texts).toEqual(["A's secret"]);
    });
    await withUserSession(backend, freshRoot("readback-b"), "user-b", 30_000, async ({ eventLog }) => {
      const texts = eventLog.listForUser("user-b").map((e) => (e.payload as { text: string }).text);
      expect(texts).toEqual(["B's secret"]);
    });
  });

  it("a stale lock past its timeout can be reclaimed, and the reclaiming session sees only the last successfully checked-in state", async () => {
    const remoteRoot = freshRoot("remote");
    const backend = new LocalStorageBackend(remoteRoot);
    const uid = "user-a";

    await withUserSession(backend, freshRoot("local-1"), uid, 30_000, async ({ eventLog }) => {
      eventLog.append({ type: "message_sent", actor: "user", payload: { text: "before the crash", attachmentOnly: false }, userId: uid });
    });

    // Simulate a crashed instance: it acquired the lock and checked out, but
    // never reached checkin (see the next describe block for what this
    // leaves behind). Use a short TTL so the test doesn't have to wait long.
    await backend.acquireLock(uid, 50);
    await sleep(80);

    await withUserSession(backend, freshRoot("local-2"), uid, 30_000, async ({ eventLog }) => {
      const texts = eventLog.listForUser(uid).map((e) => (e.payload as { text: string }).text);
      expect(texts).toEqual(["before the crash"]); // the crashed session's (nonexistent) writes are simply absent, not corrupted
      eventLog.append({ type: "message_sent", actor: "user", payload: { text: "after reclaim", attachmentOnly: false }, userId: uid });
    });
  });
});

describe("withUserSession — the crash-between-checkout-and-checkin failure mode, named", () => {
  it("a crash after checkout but before checkin leaves remote storage exactly as it was after the last successful checkin — the crashed turn's local writes are simply lost, never partially applied", async () => {
    const remoteRoot = freshRoot("remote");
    const backend = new LocalStorageBackend(remoteRoot);
    const uid = "user-a";

    await withUserSession(backend, freshRoot("local-1"), uid, 30_000, async ({ eventLog }) => {
      eventLog.append({ type: "message_sent", actor: "user", payload: { text: "safely checked in", attachmentOnly: false }, userId: uid });
    });

    // Manually drive the backend the way withUserSession would up to the
    // point of a crash: acquire the lock, download, open a connection, and
    // write — then simulate the process dying before close()/upload()/
    // releaseLock() ever run. No cleanup, no finally block — a real crash.
    const crashedLocalDir = freshRoot("crashed-local");
    await backend.acquireLock(uid, 200); // the crashed instance's own handle is never used again — it never gets the chance to release it

    await backend.download(uid, crashedLocalDir);
    const crashedEventLog = new EventLog(path.join(crashedLocalDir, "events.db"));
    crashedEventLog.append({ type: "message_sent", actor: "user", payload: { text: "written locally, never checked in", attachmentOnly: false }, userId: uid });
    // Deliberately: no close(), no upload(), no releaseLock(). This is the crash.

    // Failure mode, named: remote storage is untouched by the crashed
    // write — a fresh checkout still sees only what was checked in before
    // the crash. This is "safe" in the sense that remote is never left
    // torn or partially written; it is NOT safe in the sense of preserving
    // the crashed turn's work, which is gone once the ephemeral local disk
    // that held it is gone.
    const readbackDuringCrash = freshRoot("readback-during-crash");
    await backend.download(uid, readbackDuringCrash);
    const checkLog = new EventLog(path.join(readbackDuringCrash, "events.db"));
    expect(checkLog.listForUser(uid).map((e) => (e.payload as { text: string }).text)).toEqual(["safely checked in"]);
    checkLog.close();

    // The lock is held (not released by the crashed instance) until its
    // TTL — a new request for this user fails loudly rather than silently
    // racing the crashed instance's still-open local files.
    await expect(backend.acquireLock(uid, 30_000)).rejects.toBeInstanceOf(LockAcquisitionError);

    // Once the TTL passes, the lock is reclaimable and remote state — the
    // crashed write never having reached it — is exactly what it was
    // after the last real checkin, not corrupted, not torn, just stale.
    await sleep(250);
    await withUserSession(backend, freshRoot("post-crash-recovery"), uid, 30_000, async ({ eventLog }) => {
      expect(eventLog.listForUser(uid).map((e) => (e.payload as { text: string }).text)).toEqual(["safely checked in"]);
    });

    crashedEventLog.close();
  });
});
