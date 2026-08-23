import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { getUserDataPaths, sanitizeUidForPath, wipeUserDirectory } from "../src/storage/userDataPaths.js";
import { EventLog } from "../src/events/eventLog.js";
import { resolveTestDbDir } from "../src/test/dbPath.js";

function freshRoot(): string {
  // A fresh subdirectory per call, inside this test file's own isolated root — never a real dev-data path (EN-091).
  const root = resolveTestDbDir(import.meta.url);
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(`${root}/root-`);
}

describe("sanitizeUidForPath", () => {
  it("passes a normal Firebase-shaped UID through unchanged", () => {
    expect(sanitizeUidForPath("aB3xY9zQ1234567890abcdef")).toBe("aB3xY9zQ1234567890abcdef");
  });

  it("rejects path traversal", () => {
    expect(() => sanitizeUidForPath("../../etc/passwd")).toThrow();
  });

  it("rejects an absolute path", () => {
    expect(() => sanitizeUidForPath("/etc/passwd")).toThrow();
  });

  it("rejects an embedded path separator", () => {
    expect(() => sanitizeUidForPath("uid/../other-uid")).toThrow();
  });
});

describe("getUserDataPaths", () => {
  it("gives two different users completely disjoint directories and file paths", () => {
    const root = freshRoot();
    const a = getUserDataPaths(root, "user-a");
    const b = getUserDataPaths(root, "user-b");

    expect(a.dir).not.toBe(b.dir);
    expect(a.eventsDb).not.toBe(b.eventsDb);
    expect(a.projectionsDb).not.toBe(b.projectionsDb);
    expect(a.retrievalDb).not.toBe(b.retrievalDb);
    expect(a.blobsDir).not.toBe(b.blobsDir);
    expect(b.dir.startsWith(a.dir)).toBe(false);
    expect(a.dir.startsWith(b.dir)).toBe(false);
  });
});

describe("wipeUserDirectory — the real code path lib/serverPipeline.ts's resetUserData calls", () => {
  it("deletes exactly the given user's directory and nothing else, even a sibling directory right next to it", () => {
    const root = freshRoot();
    const a = getUserDataPaths(root, "user-a");
    const b = getUserDataPaths(root, "user-b");

    const eventLogA = new EventLog(a.eventsDb);
    eventLogA.append({ type: "message_sent", actor: "user", payload: { text: "A's secret", attachmentOnly: false }, userId: "user-a" });
    const eventLogB = new EventLog(b.eventsDb);
    eventLogB.append({ type: "message_sent", actor: "user", payload: { text: "B's secret", attachmentOnly: false }, userId: "user-b" });

    wipeUserDirectory(a, [eventLogA]);

    // A's directory is gone and recreated empty.
    expect(fs.existsSync(a.eventsDb)).toBe(false);
    expect(fs.existsSync(a.dir)).toBe(true);
    expect(fs.readdirSync(a.dir)).toEqual([]);

    // B's directory and data are completely untouched — a fresh connection reads B's message back intact.
    expect(fs.existsSync(b.eventsDb)).toBe(true);
    const rereadB = new EventLog(b.eventsDb);
    const events = rereadB.listForUser("user-b");
    expect(events).toHaveLength(1);
    expect((events[0]!.payload as { text: string }).text).toBe("B's secret");
    rereadB.close();
    eventLogB.close();
  });
});
