import { NextResponse } from "next/server";
import { sendMessage } from "../../../src/conversation/chatPipeline.js";
import { refreshMemoryAfterTurn } from "../../../src/conversation/turnMemoryRefresh.js";
import { resolveCurrentLocationContext } from "../../../src/location/currentLocation.js";
import { getChatRouter, getEmbedder, getExtractionRouter, getIntentRouter, runUserSession } from "../../../lib/serverPipeline.js";
import { authErrorResponse, requireUserId } from "../../../lib/requireUser.js";

/**
 * The ONE API route backing the chat UI (Phase 7 Part 1) — calls
 * sendMessage + refreshMemoryAfterTurn, the exact same functions
 * scripts/chat.ts (the REPL) calls. No chat/extraction/routing logic
 * lives in this file; it only adapts an HTTP request into the same
 * SendMessageDeps shape the REPL builds.
 *
 * Part B-0: this route no longer reads or forwards a client-supplied
 * `recentTurns` — the client used to resend `messages.slice(-6)` from its
 * own React state regardless of what the server actually held (app/
 * page.tsx before this fix), which meant the browser tab, not the event
 * log, was deciding what Enso could see of the session. sendMessage now
 * computes the real window itself from the event log whenever the caller
 * omits it (getSessionTurnsForPrompt), so the client only ever needs to
 * say what was just typed — the event log is the one source of truth.
 */
function getRequestIp(request: Request): string | null {
  // Standard proxy header, first entry is the original client — App Router's
  // Request has no built-in `.ip` (that was a Pages-Router-only convenience).
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return request.headers.get("x-real-ip");
}

export async function POST(request: Request): Promise<Response> {
  let userId: string;
  try {
    userId = await requireUserId(request);
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }

  const body = (await request.json()) as { text: string; attachmentEventId?: string; locationContext?: { placeName: string | null; timezone: string | null } };
  const hasText = typeof body.text === "string" && body.text.trim() !== "";
  const hasAttachment = typeof body.attachmentEventId === "string" && body.attachmentEventId.length > 0;
  // Item 8: text alone was required before, which made "attach a file and
  // send with no other text" impossible even though captureMessage
  // (R1/EN-064) already supported an attachment-only message — this just
  // never let one reach it.
  if (!hasText && !hasAttachment) {
    return NextResponse.json({ error: "text or an attachment is required" }, { status: 400 });
  }

  const embedder = await getEmbedder();
  const chatRouter = getChatRouter();
  const intentRouter = getIntentRouter();
  const extractionRouter = getExtractionRouter();

  // Ambient current-location: Tier 1 (place name) comes pre-geocoded from
  // the client (POST /api/location, called once per session — see app/
  // page.tsx); Tier 2 (IP city) and the tier-priority decision happen here,
  // server-side, since only this route has the raw request for the IP.
  const locationContext = await resolveCurrentLocationContext(
    { placeName: body.locationContext?.placeName ?? null, timezone: body.locationContext?.timezone ?? null },
    getRequestIp(request)
  );

  // Cloud Storage batch: the whole turn — sendMessage AND
  // refreshMemoryAfterTurn — runs inside one checkout/checkin cycle
  // (lib/serverPipeline.ts's runUserSession), so extraction's writes are
  // checked in along with the reply, not left stranded on local disk by a
  // checkin that already happened before extraction ran.
  const outcome = await runUserSession(userId, async ({ eventLog, projectionsDb, retrievalDb }) => {
    let result;
    try {
      result = await sendMessage(
        { eventLog, projectionsDb, retrievalDb, embedder, chatRouter, intentRouter },
        { userId, text: body.text ?? "", attachmentEventId: body.attachmentEventId, locationContext }
      );
    } catch (err) {
      return { status: 502 as const, body: { error: err instanceof Error ? err.message : String(err) } };
    }

    let memoryUpdateError: string | null = null;
    try {
      await refreshMemoryAfterTurn({ eventLog, projectionsDb, retrievalDb, embedder, extractionRouter }, userId, result.messageEvent.id);
    } catch (err) {
      memoryUpdateError = err instanceof Error ? err.message : String(err);
    }

    return {
      status: 200 as const,
      body: { replyText: result.replyText, messageEventId: result.messageEvent.id, replyEventId: result.replyEvent.id, memoryUpdateError }
    };
  });

  return NextResponse.json(outcome.body, { status: outcome.status });
}
