import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { withUserSession, getActiveCheckoutCount, waitForNoActiveCheckouts } from "../src/storage/userSession.js";
import { LocalStorageBackend } from "../src/storage/localStorageBackend.js";
import { LockAcquisitionError } from "../src/storage/userStorageBackend.js";
import { checkpointDatabase } from "../src/storage/checkpointDatabase.js";
import { resolveTestDbDir } from "../src/test/dbPath.js";

function freshRoot(name: string): string {
  const root = resolveTestDbDir(import.meta.url);
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, `${name}-`));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function walkAll(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkAll(full));
    else out.push(full);
  }
  return out;
}

describe("PART 4, bullet 1+2: lock TTL — expired is broken, live is respected", () => {
  it("a lock written with an expired timestamp is broken and acquired", async () => {
    const backend = new LocalStorageBackend(freshRoot("remote"));
    await backend.acquireLock("user-a", 20); // expires almost immediately
    await sleep(50);
    const reclaimed = await backend.acquireLock("user-a", 30_000);
    expect(reclaimed.token).toBeTruthy();
  });

  it("a lock written with a live timestamp is respected — the acquirer fails loud, never queues", async () => {
    const backend = new LocalStorageBackend(freshRoot("remote"));
    await backend.acquireLock("user-a", 30_000);
    await expect(backend.acquireLock("user-a", 30_000)).rejects.toBeInstanceOf(LockAcquisitionError);
  });
});

describe("PART 4, bullet 3: two simultaneous acquires against one expired lock — exactly one wins", () => {
  it("both race the same expired lock; exactly one succeeds, the other gets LockAcquisitionError", async () => {
    const backend = new LocalStorageBackend(freshRoot("remote"));
    await backend.acquireLock("user-a", 20);
    await sleep(50); // now expired, both racers will see it as stale

    const results = await Promise.allSettled([backend.acquireLock("user-a", 30_000), backend.acquireLock("user-a", 30_000)]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(LockAcquisitionError);
  });
});

describe("PART 2: fencing — a holder that outlived its own TTL must not keep writing", () => {
  it("isLockCurrent is false once another acquirer has reclaimed the lock", async () => {
    const backend = new LocalStorageBackend(freshRoot("remote"));
    const original = await backend.acquireLock("user-a", 20);
    await sleep(50);
    await backend.acquireLock("user-a", 30_000); // a different process reclaims it

    expect(await backend.isLockCurrent("user-a", original)).toBe(false);
  });

  it("withUserSession refuses to upload when its lock was reclaimed mid-turn — the turn's local writes are lost, remote reflects the last real checkin, never a race with the new holder", async () => {
    const remoteRoot = freshRoot("remote");
    const backend = new LocalStorageBackend(remoteRoot);
    const uid = "user-a";

    await withUserSession(backend, freshRoot("local-seed"), uid, 30_000, async ({ eventLog }) => {
      eventLog.append({ type: "message_sent", actor: "user", payload: { text: "before the reclaim", attachmentOnly: false }, userId: uid });
    });

    // A short TTL so the in-flight session's own lock expires while `work` is still running,
    // then a second acquirer reclaims it out from under the first — simulating a holder that
    // outlived its own TTL (a slow turn), not a crash.
    const attempt = withUserSession(backend, freshRoot("local-slow"), uid, 30, async ({ eventLog }) => {
      await sleep(80); // outlive the 30ms TTL
      eventLog.append({ type: "message_sent", actor: "user", payload: { text: "written after losing the lock", attachmentOnly: false }, userId: uid });
    });

    await sleep(50); // let the slow session acquire and start `work` first
    const reclaimer = await backend.acquireLock(uid, 30_000);

    await expect(attempt).rejects.toThrow(/reclaimed/);
    await backend.releaseLock(uid, reclaimer);

    await withUserSession(backend, freshRoot("local-verify"), uid, 30_000, async ({ eventLog }) => {
      const texts = eventLog.listForUser(uid).map((e) => (e.payload as { text: string }).text);
      expect(texts).toEqual(["before the reclaim"]); // the fenced-out write never reached remote
    });
  });
});

describe("PART 4, bullet 4: a simulated mid-checkout termination leaves state the next checkout recovers from", () => {
  it("a crash after checkout (acquire+download+write, no close/checkpoint/upload/release) leaves remote untouched; the next checkout after the TTL sees only the last real checkin and can write normally", async () => {
    const remoteRoot = freshRoot("remote");
    const backend = new LocalStorageBackend(remoteRoot);
    const uid = "user-a";

    await withUserSession(backend, freshRoot("local-1"), uid, 30_000, async ({ eventLog }) => {
      eventLog.append({ type: "message_sent", actor: "user", payload: { text: "safely checked in", attachmentOnly: false }, userId: uid });
    });

    // Manually drive the backend the way withUserSession would, up to the crash point.
    const crashedLocalDir = freshRoot("crashed-local");
    await backend.acquireLock(uid, 100);
    await backend.download(uid, crashedLocalDir);
    const crashedDb = new Database(path.join(crashedLocalDir, "events.db"));
    crashedDb.pragma("journal_mode = WAL");
    crashedDb.exec(`CREATE TABLE IF NOT EXISTS t(x)`); // touch it enough to create a real -wal file
    // Deliberately: no checkpoint, no close, no upload, no releaseLock — the crash.

    await expect(backend.acquireLock(uid, 30_000)).rejects.toBeInstanceOf(LockAcquisitionError);

    await sleep(150); // past the crashed lock's TTL
    await withUserSession(backend, freshRoot("post-crash"), uid, 30_000, async ({ eventLog }) => {
      const texts = eventLog.listForUser(uid).map((e) => (e.payload as { text: string }).text);
      expect(texts).toEqual(["safely checked in"]); // the crashed local write never reached remote
      eventLog.append({ type: "message_sent", actor: "user", payload: { text: "recovered normally", attachmentOnly: false }, userId: uid });
    });

    await withUserSession(backend, freshRoot("post-crash-verify"), uid, 30_000, async ({ eventLog }) => {
      const texts = eventLog.listForUser(uid).map((e) => (e.payload as { text: string }).text);
      expect(texts).toEqual(["safely checked in", "recovered normally"]);
    });

    crashedDb.close();
  });
});

describe("PART 4, bullet 5 / PART 1: checkin uploads no sidecar files and the uploaded .db is self-contained", () => {
  it("after a real write session, remote holds only main .db files — no -wal/-shm anywhere", async () => {
    const remoteRoot = freshRoot("remote");
    const backend = new LocalStorageBackend(remoteRoot);
    const uid = "user-a";

    await withUserSession(backend, freshRoot("local"), uid, 30_000, async ({ eventLog, projectionsDb, retrievalDb }) => {
      eventLog.append({ type: "message_sent", actor: "user", payload: { text: "hello", attachmentOnly: false }, userId: uid });
      void projectionsDb;
      void retrievalDb;
    });

    const remoteFiles = walkAll(path.join(remoteRoot, "users", uid));
    const sidecars = remoteFiles.filter((f) => f.endsWith("-wal") || f.endsWith("-shm") || f.endsWith("-journal"));
    expect(sidecars).toEqual([]);
    expect(remoteFiles.some((f) => f.endsWith("events.db"))).toBe(true);

    // Self-contained: a fresh checkout of just the main file (no sidecars accompanying it,
    // since none were uploaded) still opens and reads back correctly.
    await withUserSession(backend, freshRoot("readback"), uid, 30_000, async ({ eventLog }) => {
      expect(eventLog.listForUser(uid).map((e) => (e.payload as { text: string }).text)).toEqual(["hello"]);
    });
  });

  it("a legacy leftover -wal with committed data (simulating the production incident) is preserved and self-heals on the next real checkin — no special-case code, no data loss", async () => {
    const remoteRoot = freshRoot("remote");
    const backend = new LocalStorageBackend(remoteRoot);
    const uid = "user-a";

    // Build a WAL-mode db locally with a committed write still sitting in the WAL (never
    // checkpointed), then upload it AS-IS (including the sidecars) via the raw backend —
    // simulating exactly what production had: a torn checkin from before this fix existed.
    // A second connection is kept open across the write so closing the first is NOT closing
    // the last connection — SQLite only auto-checkpoints on a last-connection close, so this
    // is what actually reproduces a real leftover WAL with committed data (a plain single-
    // connection close(), it turns out, already auto-checkpoints on its own; the real gap this
    // batch closes is that a hard crash/SIGKILL means close() never runs AT ALL — see PART 3).
    const legacyLocalDir = freshRoot("legacy-local");
    const legacyDb = new Database(path.join(legacyLocalDir, "events.db"));
    legacyDb.pragma("journal_mode = WAL");
    legacyDb.exec(`CREATE TABLE legacy(id INTEGER PRIMARY KEY, val TEXT)`);
    legacyDb.exec(`INSERT INTO legacy(val) VALUES ('committed but never checkpointed')`);
    const secondConnection = new Database(path.join(legacyLocalDir, "events.db"));
    secondConnection.pragma("journal_mode = WAL");
    secondConnection.exec("BEGIN"); // an open read transaction blocks the auto-checkpoint on legacyDb.close() below
    secondConnection.prepare("SELECT * FROM legacy").get();
    legacyDb.close();
    expect(fs.existsSync(path.join(legacyLocalDir, "events.db-wal"))).toBe(true);
    const walSizeBeforeUpload = fs.statSync(path.join(legacyLocalDir, "events.db-wal")).size;
    expect(walSizeBeforeUpload).toBeGreaterThan(0);

    // backend.upload() now structurally refuses to ever upload a sidecar (PART 1), so it can't
    // be used to seed this scenario — write directly into where LocalStorageBackend keeps
    // "remote" on disk instead, simulating data that predates this fix and is already sitting
    // in GCS today (this is exactly the shape found in the real production prefix).
    const remoteUserDir = path.join(remoteRoot, "users", uid);
    fs.mkdirSync(remoteUserDir, { recursive: true });
    fs.cpSync(legacyLocalDir, remoteUserDir, { recursive: true });
    secondConnection.exec("COMMIT");
    secondConnection.close();
    expect(fs.existsSync(path.join(remoteUserDir, "events.db-wal"))).toBe(true);

    // The next REAL checkout+checkin cycle downloads the legacy sidecar, opens it (SQLite
    // replays the WAL automatically on open, folding the committed row into the main file's
    // view), and this batch's checkpoint step then removes the sidecar on checkin.
    await withUserSession(backend, freshRoot("healing-checkout"), uid, 30_000, async ({ eventLog }) => {
      const raw = eventLog.db.prepare(`SELECT val FROM legacy`).all() as { val: string }[];
      expect(raw.map((r) => r.val)).toEqual(["committed but never checkpointed"]); // preserved, not lost
    });

    const remoteFiles = walkAll(path.join(remoteRoot, "users", uid));
    expect(remoteFiles.some((f) => f.endsWith("-wal") || f.endsWith("-shm"))).toBe(false); // self-healed
  });
});

describe("checkpointDatabase — verifies the checkpoint actually succeeded rather than assuming it", () => {
  it("checkpoints cleanly and truncates a real WAL file to nothing", () => {
    const dir = freshRoot("checkpoint-ok");
    const dbPath = path.join(dir, "t.db");
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.exec(`CREATE TABLE t(x)`);
    db.exec(`INSERT INTO t VALUES (1)`);
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(true);

    expect(() => checkpointDatabase(db, dbPath, "t.db")).not.toThrow();

    const walSize = fs.existsSync(`${dbPath}-wal`) ? fs.statSync(`${dbPath}-wal`).size : 0;
    expect(walSize).toBe(0);
    db.close();
  });

  it("fails loud rather than silently proceeding when the checkpoint can't fully complete (a second connection holds a read transaction open)", () => {
    const dir = freshRoot("checkpoint-busy");
    const dbPath = path.join(dir, "t.db");
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.exec(`CREATE TABLE t(x)`);
    db.exec(`INSERT INTO t VALUES (1)`);

    const reader = new Database(dbPath);
    reader.pragma("journal_mode = WAL");
    reader.exec("BEGIN"); // open an unfinished read transaction so TRUNCATE cannot fully checkpoint
    reader.prepare("SELECT * FROM t").get();

    expect(() => checkpointDatabase(db, dbPath, "t.db")).toThrow(/did not complete cleanly/);

    reader.exec("COMMIT");
    reader.close();
    db.close();
  });
});

describe("PART 3: SIGTERM support — the in-flight checkout registry", () => {
  it("waitForNoActiveCheckouts resolves immediately when nothing is in flight", async () => {
    expect(getActiveCheckoutCount()).toBe(0);
    await expect(waitForNoActiveCheckouts(50)).resolves.toBe(true);
  });

  it("waitForNoActiveCheckouts resolves true once an in-flight checkout finishes, before its timeout", async () => {
    const backend = new LocalStorageBackend(freshRoot("remote"));
    const uid = "user-a";

    const session = withUserSession(backend, freshRoot("local"), uid, 30_000, async () => {
      await sleep(40);
    });

    await sleep(5);
    expect(getActiveCheckoutCount()).toBeGreaterThan(0);

    const waited = waitForNoActiveCheckouts(2000);
    await session;
    await expect(waited).resolves.toBe(true);
    expect(getActiveCheckoutCount()).toBe(0);
  });

  it("waitForNoActiveCheckouts resolves false if the checkout doesn't finish within the budget", async () => {
    const backend = new LocalStorageBackend(freshRoot("remote"));
    const uid = "user-a";

    const session = withUserSession(backend, freshRoot("local"), uid, 30_000, async () => {
      await sleep(200);
    });

    await sleep(5);
    await expect(waitForNoActiveCheckouts(30)).resolves.toBe(false);
    await session;
  });
});
