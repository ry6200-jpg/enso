import fs from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/events/eventLog.js";
import { BlobStore } from "../src/blobs/blobStore.js";
import { captureUpload, MAX_UPLOAD_BYTES, UploadTooLargeError, type FileUploadedPayload } from "../src/attachments/attachmentCapture.js";
import { freshTestDbPath, resolveTestDbDir } from "../src/test/dbPath.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";

let eventLog: EventLog;
let blobStore: BlobStore;

beforeEach(() => {
  eventLog = new EventLog(freshTestDbPath(import.meta.url, "events"));
  blobStore = new BlobStore(resolveTestDbDir(import.meta.url) + "-blobs");
});

describe("captureUpload (EN-061)", () => {
  it("stores every upload: real bytes on disk, file_uploaded event with metadata and path", () => {
    const bytes = Buffer.from("a real pdf's worth of bytes, for testing");
    const event = captureUpload(eventLog, blobStore, {
      userId: PRIMARY_USER_ID,
      bytes,
      filename: "notes.pdf",
      mimeType: "application/pdf"
    });

    expect(event.type).toBe("file_uploaded");
    const payload = event.payload as FileUploadedPayload;
    expect(payload.filename).toBe("notes.pdf");
    expect(payload.mimeType).toBe("application/pdf");
    expect(payload.byteLength).toBe(bytes.length);

    const absolute = blobStore.get(payload.path);
    expect(absolute.toString()).toBe(bytes.toString());
  });

  it("does not discard by type or content — a non-document, non-image file is stored the same way", () => {
    const bytes = Buffer.from("just some random bytes");
    const event = captureUpload(eventLog, blobStore, {
      userId: PRIMARY_USER_ID,
      bytes,
      filename: "data.bin",
      mimeType: "application/octet-stream"
    });
    expect(event.type).toBe("file_uploaded");
    expect(blobStore.exists((event.payload as FileUploadedPayload).path)).toBe(true);
  });

  it("rejects an upload over the ~100MB ceiling with a clear human-readable error, not a silent failure", () => {
    const oversized = Buffer.alloc(MAX_UPLOAD_BYTES + 1);
    expect(() =>
      captureUpload(eventLog, blobStore, { userId: PRIMARY_USER_ID, bytes: oversized, filename: "huge.bin", mimeType: "application/octet-stream" })
    ).toThrow(UploadTooLargeError);

    try {
      captureUpload(eventLog, blobStore, { userId: PRIMARY_USER_ID, bytes: oversized, filename: "huge.bin", mimeType: "application/octet-stream" });
    } catch (err) {
      expect((err as Error).message).toMatch(/MB/);
      expect((err as Error).message).toMatch(/limit/i);
    }
    expect(eventLog.count()).toBe(0); // rejected before any event was recorded
  });

  it("accepts a file right at the ceiling", () => {
    const atLimit = Buffer.alloc(MAX_UPLOAD_BYTES);
    const event = captureUpload(eventLog, blobStore, {
      userId: PRIMARY_USER_ID,
      bytes: atLimit,
      filename: "exactly-at-limit.bin",
      mimeType: "application/octet-stream"
    });
    expect(event.type).toBe("file_uploaded");
  });
});
