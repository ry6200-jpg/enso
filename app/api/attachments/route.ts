import { NextResponse } from "next/server";
import { uploadAndExtract } from "../../../src/attachments/uploadAndExtract.js";
import { UploadTooLargeError } from "../../../src/attachments/attachmentCapture.js";
import { listUploads } from "../../../src/attachments/uploadDeletion.js";
import { getDocumentRouter, getImageRouter, runReadOnlyUserSession, runUserSession } from "../../../lib/serverPipeline.js";
import { authErrorResponse, requireUserId } from "../../../lib/requireUser.js";

/**
 * EN-065's uploads-list surface: didn't exist at all before this — there
 * was no way to even see what you'd uploaded, let alone delete one.
 * Deleted uploads are excluded (listUploads already filters them via the
 * same eclipsed-set logic deletion itself uses).
 *
 * Refresh-blank-chat batch follow-up: this handler never writes through
 * its stores (unlike POST below, which genuinely uploads and stays on
 * runUserSession), so it uses runReadOnlyUserSession (see
 * src/storage/userSession.ts) — same reduced-lock-contention reasoning as
 * app/api/history/route.ts.
 */
export async function GET(request: Request): Promise<Response> {
  let userId: string;
  try {
    userId = await requireUserId(request);
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }

  const uploads = await runReadOnlyUserSession(userId, async ({ eventLog }) => listUploads(eventLog, userId));
  return NextResponse.json({ uploads });
}

/**
 * EN-061/062: store every upload, always, then attempt content extraction
 * and report success or failure honestly — never silently drop a failed
 * extraction, and never skip storing the file itself. Calls
 * uploadAndExtract (src/attachments/), the same orchestrator any future
 * surface would use — no upload logic duplicated here.
 */
export async function POST(request: Request): Promise<Response> {
  let userId: string;
  try {
    userId = await requireUserId(request);
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }

  const formData = await request.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }

  const documentRouter = getDocumentRouter();
  const imageRouter = getImageRouter();
  const bytes = Buffer.from(await file.arrayBuffer());

  let result;
  try {
    result = await runUserSession(userId, async ({ eventLog, blobStore }) =>
      uploadAndExtract({ eventLog, blobStore, documentRouter, imageRouter }, { userId, bytes, filename: file.name, mimeType: file.type || "application/octet-stream" })
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
