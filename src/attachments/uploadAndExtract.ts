import type { EventLog } from "../events/eventLog.js";
import type { EventRecord } from "../events/schema.js";
import type { BlobStore } from "../blobs/blobStore.js";
import { captureUpload } from "./attachmentCapture.js";
import { extractDocumentContent, extractImageContent } from "./attachmentContent.js";
import type { DocumentContentAdapter, ImageContentAdapter } from "../providers/attachmentTypes.js";

export interface UploadAndExtractDeps {
  eventLog: EventLog;
  blobStore: BlobStore;
  documentRouter: { extract: DocumentContentAdapter };
  imageRouter: { extract: ImageContentAdapter };
}

export interface UploadAndExtractResult {
  uploadEvent: EventRecord;
  /** Set when extraction succeeded. */
  extractionEvent?: EventRecord;
  /** Set when extraction failed — the upload itself is never lost either way (EN-061: store every upload, always), only the content extraction step can fail, and it's reported honestly here rather than silently dropped. */
  extractionError?: string;
}

/**
 * The full EN-061/062 upload path in one place: store the file (always,
 * unconditionally — captureUpload never inspects content to decide
 * keep/discard), then attempt content extraction (full text for
 * documents, a description for images) and record the result — or its
 * failure — honestly. This is the shared orchestrator the web app's
 * upload API route calls; not duplicated into the route handler.
 */
export async function uploadAndExtract(
  deps: UploadAndExtractDeps,
  input: { userId: string; bytes: Buffer; filename: string; mimeType: string }
): Promise<UploadAndExtractResult> {
  const uploadEvent = captureUpload(deps.eventLog, deps.blobStore, input);

  try {
    const extractionEvent = input.mimeType.startsWith("image/")
      ? await extractImageContent(deps.eventLog, deps.imageRouter, uploadEvent, { bytes: input.bytes, mimeType: input.mimeType })
      : await extractDocumentContent(deps.eventLog, deps.documentRouter, uploadEvent, { bytes: input.bytes, mimeType: input.mimeType, filename: input.filename });
    return { uploadEvent, extractionEvent };
  } catch (err) {
    return { uploadEvent, extractionError: err instanceof Error ? err.message : String(err) };
  }
}
