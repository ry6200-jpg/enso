import { NextResponse } from "next/server";
import { sendMessage } from "../../../src/conversation/chatPipeline.js";
import { refreshMemoryAfterTurn } from "../../../src/conversation/turnMemoryRefresh.js";
import type { RecentTurnForPrompt } from "../../../src/persona/systemPrompt.js";
import { getChatRouter, getDevUserId, getEmbedder, getExtractionRouter, getIntentRouter, getStores } from "../../../lib/serverPipeline.js";

/**
 * The ONE API route backing the chat UI (Phase 7 Part 1) — calls
 * sendMessage + refreshMemoryAfterTurn, the exact same functions
 * scripts/chat.ts (the REPL) calls. No chat/extraction/routing logic
 * lives in this file; it only adapts an HTTP request into the same
 * SendMessageDeps shape the REPL builds.
 */
export async function POST(request: Request): Promise<Response> {
  const body = (await request.json()) as { text: string; recentTurns: RecentTurnForPrompt[] };
  if (typeof body.text !== "string" || body.text.trim() === "") {
    return NextResponse.json({ error: "text is required" }, { status: 400 });
  }

  const userId = getDevUserId();
  const { eventLog, projectionsDb, retrievalDb } = getStores();
  const embedder = await getEmbedder();
  const chatRouter = getChatRouter();
  const intentRouter = getIntentRouter();
  const extractionRouter = getExtractionRouter();

  let result;
  try {
    result = await sendMessage({ eventLog, projectionsDb, retrievalDb, embedder, chatRouter, intentRouter }, { userId, text: body.text, recentTurns: body.recentTurns ?? [] });
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
