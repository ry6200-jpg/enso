import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LocalStorageBackend } from "../src/storage/localStorageBackend.js";
import { LockAcquisitionError } from "../src/storage/userStorageBackend.js";
import { resolveTestDbDir } from "../src/test/dbPath.js";

function freshRoot(name: string): string {
  const root = resolveTestDbDir(import.meta.url);
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, `${name}-`));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("LocalStorageBackend — download/upload round-trip", () => {
  it("round-trips a file tree (including nested blob paths) byte-identically", async () => {
    const remoteRoot = freshRoot("remote");
    const backend = new LocalStorageBackend(remoteRoot);
    const localDir = freshRoot("local");

    // Nothing uploaded yet — download of a brand-new user must not throw, just leave localDir empty.
    await backend.download("user-a", localDir);
    expect(fs.readdirSync(localDir)).toEqual([]);

    fs.writeFileSync(path.join(localDir, "events.db"), Buffer.from("event bytes"));
    fs.mkdirSync(path.join(localDir, "blobs", "ab"), { recursive: true });
    fs.writeFileSync(path.join(localDir, "blobs", "ab", "photo.png"), Buffer.from([0, 1, 2, 255, 254]));

    await backend.upload("user-a", localDir);

    const roundTripDir = freshRoot("roundtrip");
    await backend.download("user-a", roundTripDir);

    expect(fs.readFileSync(path.join(roundTripDir, "events.db"))).toEqual(Buffer.from("event bytes"));
    expect(fs.readFileSync(path.join(roundTripDir, "blobs", "ab", "photo.png"))).toEqual(Buffer.from([0, 1, 2, 255, 254]));
  });

  it("download wipes stale local content that no longer exists remotely, rather than leaving it to be re-uploaded", async () => {
    const remoteRoot = freshRoot("remote");
    const backend = new LocalStorageBackend(remoteRoot);
    const localDir = freshRoot("local");

    fs.writeFileSync(path.join(localDir, "events.db"), Buffer.from("first version"));
    await backend.upload("user-a", localDir);

    // Simulate a second instance uploading a version with fewer files (e.g. after a wipe).
    const otherLocalDir = freshRoot("other-local");
    fs.writeFileSync(path.join(otherLocalDir, "events.db"), Buffer.from("second version, blobs deleted"));
    await backend.upload("user-a", otherLocalDir);

    // A stale local directory that still has an old file the remote no longer has...
    const staleLocalDir = freshRoot("stale-local");
    fs.mkdirSync(path.join(staleLocalDir, "blobs"), { recursive: true });
    fs.writeFileSync(path.join(staleLocalDir, "blobs", "ghost.png"), Buffer.from("should not survive"));

    // ...must be wiped by the next checkout, not merged with what remote actually has.
    await backend.download("user-a", staleLocalDir);
    expect(fs.existsSync(path.join(staleLocalDir, "blobs", "ghost.png"))).toBe(false);
    expect(fs.readFileSync(path.join(staleLocalDir, "events.db"))).toEqual(Buffer.from("second version, blobs deleted"));
  });

  it("two different users' data never interferes", async () => {
    const remoteRoot = freshRoot("remote");
    const backend = new LocalStorageBackend(remoteRoot);

    const localA = freshRoot("local-a");
    fs.writeFileSync(path.join(localA, "events.db"), Buffer.from("A's data"));
    await backend.upload("user-a", localA);

    const localB = freshRoot("local-b");
    fs.writeFileSync(path.join(localB, "events.db"), Buffer.from("B's data"));
    await backend.upload("user-b", localB);

    const readbackA = freshRoot("readback-a");
    await backend.download("user-a", readbackA);
    const readbackB = freshRoot("readback-b");
    await backend.download("user-b", readbackB);

    expect(fs.readFileSync(path.join(readbackA, "events.db"))).toEqual(Buffer.from("A's data"));
    expect(fs.readFileSync(path.join(readbackB, "events.db"))).toEqual(Buffer.from("B's data"));
  });
});

describe("LocalStorageBackend — locking", () => {
  it("a second acquire while the lock is held fails loudly, not silently or by queueing", async () => {
    const remoteRoot = freshRoot("remote");
    const backend = new LocalStorageBackend(remoteRoot);

    const handle = await backend.acquireLock("user-a", 60_000);
    expect(handle.token).toBeTruthy();

    await expect(backend.acquireLock("user-a", 60_000)).rejects.toBeInstanceOf(LockAcquisitionError);

    await backend.releaseLock("user-a", handle);
  });

  it("a stale lock past its TTL can be reclaimed", async () => {
    const remoteRoot = freshRoot("remote");
    const backend = new LocalStorageBackend(remoteRoot);

    await backend.acquireLock("user-a", 50); // deliberately short TTL, simulating a crashed instance
    await sleep(80);

    const reclaimed = await backend.acquireLock("user-a", 60_000);
    expect(reclaimed.token).toBeTruthy();
    await backend.releaseLock("user-a", reclaimed);
  });

  it("releasing with a stale (already-reclaimed) handle is a safe no-op — it must never delete the new holder's lock", async () => {
    const remoteRoot = freshRoot("remote");
    const backend = new LocalStorageBackend(remoteRoot);

    const original = await backend.acquireLock("user-a", 50);
    await sleep(80);
    const reclaimer = await backend.acquireLock("user-a", 60_000);

    // The original holder, unaware it was reclaimed, tries to release its now-stale handle.
    await backend.releaseLock("user-a", original);

    // The reclaimer's lock must still be held — a third party still can't acquire it.
    await expect(backend.acquireLock("user-a", 60_000)).rejects.toBeInstanceOf(LockAcquisitionError);

    await backend.releaseLock("user-a", reclaimer);
  });

  it("two different users can hold locks concurrently without interfering", async () => {
    const remoteRoot = freshRoot("remote");
    const backend = new LocalStorageBackend(remoteRoot);

    const [handleA, handleB] = await Promise.all([backend.acquireLock("user-a", 60_000), backend.acquireLock("user-b", 60_000)]);
    expect(handleA.token).not.toBe(handleB.token);

    await Promise.all([backend.releaseLock("user-a", handleA), backend.releaseLock("user-b", handleB)]);
  });
});
