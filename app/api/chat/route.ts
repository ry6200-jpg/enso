import { NextResponse } from "next/server";
import { sendMessage } from "../../../src/conversation/chatPipeline.js";
import { refreshMemoryAfterTurn } from "../../../src/conversation/turnMemoryRefresh.js";
import { getChatRouter, getDevUserId, getEmbedder, getExtractionRouter, getIntentRouter, getStores } from "../../../lib/serverPipeline.js";

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
export async function POST(request: Request): Promise<Response> {
  const body = (await request.json()) as { text: string; attachmentEventId?: string };
  const hasText = typeof body.text === "string" && body.text.trim() !== "";
  const hasAttachment = typeof body.attachmentEventId === "string" && body.attachmentEventId.length > 0;
  // Item 8: text alone was required before, which made "attach a file and
  // send with no other text" impossible even though captureMessage
  // (R1/EN-064) already supported an attachment-only message — this just
  // never let one reach it.
  if (!hasText && !hasAttachment) {
    return NextResponse.json({ error: "text or an attachment is required" }, { status: 400 });
  }

  const userId = getDevUserId();
  const { eventLog, projectionsDb, retrievalDb } = getStores();
  const embedder = await getEmbedder();
  const chatRouter = getChatRouter();
  const intentRouter = getIntentRouter();
  const extractionRouter = getExtractionRouter();

  let result;
  try {
    result = await sendMessage(
      { eventLog, projectionsDb, retrievalDb, embedder, chatRouter, intentRouter },
      { userId, text: body.text ?? "", attachmentEventId: body.attachmentEventId }
    );
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }

  let memoryUpdateError: string | null = null;
  try {
    await refreshMemoryAfterTurn({ eventLog, projectionsDb, retrievalDb, embedder, extractionRouter }, userId, result.messageEvent.id);
  } catch (err) {
    memoryUpdateError = err instanceof Error ? err.message : String(err);
  }

  return NextResponse.json({
    replyText: result.replyText,
    messageEventId: result.messageEvent.id,
    replyEventId: result.replyEvent.id,
    memoryUpdateError
  });
}
