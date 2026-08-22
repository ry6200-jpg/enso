import { NextResponse } from "next/server";
import { uploadAndExtract } from "../../../src/attachments/uploadAndExtract.js";
import { UploadTooLargeError } from "../../../src/attachments/attachmentCapture.js";
import { listUploads } from "../../../src/attachments/uploadDeletion.js";
import { getBlobStore, getDevUserId, getDocumentRouter, getImageRouter, getStores } from "../../../lib/serverPipeline.js";

/**
 * EN-065's uploads-list surface: didn't exist at all before this — there
 * was no way to even see what you'd uploaded, let alone delete one.
 * Deleted uploads are excluded (listUploads already filters them via the
 * same eclipsed-set logic deletion itself uses).
 */
export async function GET(): Promise<Response> {
  const userId = getDevUserId();
  const { eventLog } = getStores();
  return NextResponse.json({ uploads: listUploads(eventLog, userId) });
}

/**
 * EN-061/062: store every upload, always, then attempt content extraction
 * and report success or failure honestly — never silently drop a failed
 * extraction, and never skip storing the file itself. Calls
 * uploadAndExtract (src/attachments/), the same orchestrator any future
 * surface would use — no upload logic duplicated here.
 */
export async function POST(request: Request): Promise<Response> {
  const formData = await request.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }

  const userId = getDevUserId();
  const { eventLog } = getStores();
  const blobStore = getBlobStore();
  const documentRouter = getDocumentRouter();
  const imageRouter = getImageRouter();

  const bytes = Buffer.from(await file.arrayBuffer());

  let result;
  try {
    result = await uploadAndExtract(
      { eventLog, blobStore, documentRouter, imageRouter },
      { userId, bytes, filename: file.name, mimeType: file.type || "application/octet-stream" }
    );
  } catch (err) {
    if (err instanceof UploadTooLargeError) {
      return NextResponse.json({ error: err.message }, { status: 413 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }

  return NextResponse.json({
    uploadEventId: result.uploadEvent.id,
    filename: file.name,
    extractionSucceeded: Boolean(result.extractionEvent),
    extractionEventId: result.extractionEvent?.id ?? null,
    extractionError: result.extractionError ?? null
  });
}
