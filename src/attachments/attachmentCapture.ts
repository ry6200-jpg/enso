import type { BlobStore } from "../blobs/blobStore.js";
import type { EventLog } from "../events/eventLog.js";
import type { EventRecord } from "../events/schema.js";

/** ~100MB ceiling (EN-061): a clear human-readable failure, never a silent one. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export class UploadTooLargeError extends Error {
  constructor(
    readonly byteLength: number,
    readonly maxBytes: number
  ) {
    super(
      `This file is ${(byteLength / (1024 * 1024)).toFixed(1)}MB, which is over the ` +
        `${(maxBytes / (1024 * 1024)).toFixed(0)}MB limit for uploads. Please upload a smaller file.`
    );
    this.name = "UploadTooLargeError";
  }
}

export interface CaptureUploadInput {
  userId: string;
  bytes: Buffer;
  filename: string;
  mimeType: string;
}

export interface FileUploadedPayload {
  filename: string;
  mimeType: string;
  byteLength: number;
  path: string;
}

/**
 * EN-065's tombstone event (see src/attachments/uploadDeletion.ts for the
 * function that appends this). The event log is append-only — this never
 * edits or removes the original file_uploaded/extraction_completed events;
 * it's a new fact ("this upload is deleted") that rebuild honors by
 * treating the eclipsed events as if they don't exist when re-deriving
 * projections. removedFactCount/preservedFactCount are computed ONCE, at
 * the moment of deletion, and recorded here rather than left to be
 * recomputed later — round-trip survival (CLAUDE.md): what the user was
 * actually told before confirming must stay reconstructable even if more
 * mentions accrue elsewhere afterward and would shift the count if
 * recomputed fresh.
 */
export interface UploadDeletedPayload {
  uploadEventId: string;
  filename: string;
  removedFactCount: number;
  preservedFactCount: number;
}

/**
 * Store every upload, always (EN-061): no content inspection for
 * keep/discard, no tiering by type, no size-based discarding below the
 * hard ceiling. Bytes go to the blob store (EN-051); the event records
 * metadata and the returned path, never the bytes themselves.
 */
export function captureUpload(eventLog: EventLog, blobStore: BlobStore, input: CaptureUploadInput): EventRecord {
  if (input.bytes.length > MAX_UPLOAD_BYTES) {
    throw new UploadTooLargeError(input.bytes.length, MAX_UPLOAD_BYTES);
  }

  const stored = blobStore.put(input.bytes, input.filename);

  const payload: FileUploadedPayload = {
    filename: input.filename,
    mimeType: input.mimeType,
    byteLength: stored.byteLength,
    path: stored.relativePath
  };

  return eventLog.append({
    type: "file_uploaded",
    actor: "user",
    payload,
    userId: input.userId
  });
}
