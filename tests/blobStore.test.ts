import fs from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { BlobStore } from "../src/blobs/blobStore.js";
import { resolveTestDbDir } from "../src/test/dbPath.js";

let store: BlobStore;
let rootDir: string;

beforeEach(() => {
  rootDir = resolveTestDbDir(import.meta.url) + "-blobs";
  store = new BlobStore(rootDir);
});

describe("BlobStore (EN-051)", () => {
  it("writes bytes to disk under an id-based path, never into SQLite", () => {
    const bytes = Buffer.from("hello world");
    const stored = store.put(bytes, "note.txt");

    expect(stored.id).toMatch(/^[0-9A-Z]{26}$/);
    expect(stored.relativePath).toContain(stored.id);
    expect(fs.existsSync(stored.absolutePath)).toBe(true);
    expect(store.get(stored.relativePath).toString()).toBe("hello world");
    expect(stored.byteLength).toBe(bytes.length);
  });

  it("preserves the file extension so content type is recoverable from the path", () => {
    const stored = store.put(Buffer.from("fake image bytes"), "photo.JPG");
    expect(stored.relativePath.endsWith(".JPG")).toBe(true);
  });

  it("assigns distinct ids/paths to two uploads with the same filename", () => {
    const a = store.put(Buffer.from("v1"), "same.txt");
    const b = store.put(Buffer.from("v2"), "same.txt");
    expect(a.relativePath).not.toEqual(b.relativePath);
    expect(store.get(a.relativePath).toString()).toBe("v1");
    expect(store.get(b.relativePath).toString()).toBe("v2");
  });

  it("removes bytes on delete (used by the upload_deleted tombstone path)", () => {
    const stored = store.put(Buffer.from("gone soon"), "temp.txt");
    expect(store.exists(stored.relativePath)).toBe(true);
    store.remove(stored.relativePath);
    expect(store.exists(stored.relativePath)).toBe(false);
  });

  it("refuses to resolve a path that escapes the store root", () => {
    expect(() => store.get("../../etc/passwd")).toThrow(/outside the blob store root/);
  });
});
