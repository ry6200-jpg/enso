import { NextResponse } from "next/server";
import { getConversationHistory } from "../../../src/conversation/conversationHistory.js";
import { runUserSession } from "../../../lib/serverPipeline.js";
import { authErrorResponse, requireUserId } from "../../../lib/requireUser.js";
import { PROACTIVE_OPENER_MESSAGE } from "../../../src/persona/proactiveOpener.js";

/**
 * Item 9: the chat page reads its message history from here on mount,
 * instead of always starting from an empty array (the actual cause of
 * conversation appearing to vanish on refresh — the event log itself was
 * never touched). An empty result here is also how the client knows a
 * session is genuinely fresh, for the proactive-opener check (item 13) —
 * no separate "is this the first session" endpoint needed.
 *
 * The opener text itself is owned entirely server-side: when the log is
 * genuinely empty, this response substitutes the fixed opener line rather
 * than an empty array. Previously app/page.tsx imported
 * src/persona/proactiveOpener.ts directly to render this same fallback —
 * two sources for one string, and the one Turbopack couldn't bundle for
 * the client (see next.config.ts). The substituted message is still never
 * written to the event log — see proactiveOpener.ts for why.
 */
export async function GET(request: Request): Promise<Response> {
  let userId: string;
  try {
    userId = await requireUserId(request);
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }

  const messages = await runUserSession(userId, async ({ eventLog }) => getConversationHistory(eventLog, userId));
  return NextResponse.json({
    messages: messages.length > 0 ? messages : [{ id: "proactive-opener", role: "enso" as const, text: PROACTIVE_OPENER_MESSAGE }]
  });
}
