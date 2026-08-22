import { NextResponse } from "next/server";
import { getConversationHistory } from "../../../src/conversation/conversationHistory.js";
import { getDevUserId, getStores } from "../../../lib/serverPipeline.js";

/**
 * Item 9: the chat page reads its message history from here on mount,
 * instead of always starting from an empty array (the actual cause of
 * conversation appearing to vanish on refresh — the event log itself was
 * never touched). An empty result here is also how the client knows a
 * session is genuinely fresh, for the proactive-opener check (item 13) —
 * no separate "is this the first session" endpoint needed.
 */
export async function GET(): Promise<Response> {
  const userId = getDevUserId();
  const { eventLog } = getStores();
  return NextResponse.json({ messages: getConversationHistory(eventLog, userId) });
}
