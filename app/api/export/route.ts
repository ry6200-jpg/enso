import { NextResponse } from "next/server";
import { runReadOnlyUserSession } from "../../../lib/serverPipeline.js";
import { authErrorResponse, requireUserId } from "../../../lib/requireUser.js";
import { getExportEvents, streamTranscriptJson, streamTranscriptTxt, type ExportFormat } from "../../../src/export/transcriptExport.js";

/** Wraps a plain-string generator (transcriptExport.ts) into a Web ReadableStream, so the response body is written incrementally rather than buffered as one string. */
function generatorToByteStream(source: Generator<string>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const { value, done } = source.next();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(value));
    }
  });
}

/**
 * Full transcript export (production bug batch, item 5 — pure data
 * plumbing, no LLM calls). `?format=txt` (default) or `?format=json`.
 *
 * Identity comes ONLY from requireUserId (the verified request token) —
 * there is no query param or body field that can select whose data comes
 * back, by design; this route accepts no user-identifying input at all
 * besides the token every other route already requires.
 *
 * Read-only (runReadOnlyUserSession): a checkout with no checkin, exactly
 * like GET /api/history — never appends anything, never touches
 * checkout/checkin state. Every message_sent/reply_sent event is returned,
 * in full, in log order — no session window, unlike ordinary chat context.
 */
export async function GET(request: Request): Promise<Response> {
  let userId: string;
  try {
    userId = await requireUserId(request);
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }

  const url = new URL(request.url);
  const format: ExportFormat = url.searchParams.get("format") === "json" ? "json" : "txt";

  const events = await runReadOnlyUserSession(userId, async ({ eventLog }) => getExportEvents(eventLog, userId));

  const body = generatorToByteStream(format === "json" ? streamTranscriptJson(events) : streamTranscriptTxt(events));
  const dateStamp = new Date().toISOString().slice(0, 10);

  return new Response(body, {
    headers: {
      "Content-Type": format === "json" ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="enso-transcript-${dateStamp}.${format}"`
    }
  });
}
