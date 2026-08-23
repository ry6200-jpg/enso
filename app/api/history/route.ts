import { NextResponse } from "next/server";
import { getConversationHistory } from "../../../src/conversation/conversationHistory.js";
import { runReadOnlyUserSession, getChatRouter } from "../../../lib/serverPipeline.js";
import { authErrorResponse, requireUserId } from "../../../lib/requireUser.js";
import { PROACTIVE_OPENER_MESSAGE } from "../../../src/persona/proactiveOpener.js";
import { generateWelcomeBackMessage, getWelcomeBackEligibility } from "../../../src/persona/welcomeBack.js";

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
 *
 * Font-size/refresh/welcome-back batch, item 3: real history that ISN'T
 * empty gets one more check — src/persona/welcomeBack.ts's gap-based
 * eligibility, computed inside the same read-only checkout used to fetch
 * history itself (no second lock round trip). Below the gap threshold
 * this is a free local Date-diff and nothing else happens. At or above
 * it, exactly one chat-router call generates a short greeting, appended
 * as the final message — deliberately run AFTER the checkout has already
 * released (same reason the zodiac-sidebar route's own LLM call sits
 * outside its checkout: never hold the per-user lock across a network
 * call). Like the proactive opener, this greeting is never written to the
 * event log — display-time only.
 */
export async function GET(request: Request): Promise<Response> {
  let userId: string;
  try {
    userId = await requireUserId(request);
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }

  const { messages, welcomeBack } = await runReadOnlyUserSession(userId, async ({ eventLog }) => {
    const messages = getConversationHistory(eventLog, userId);
    return { messages, welcomeBack: messages.length > 0 ? getWelcomeBackEligibility(eventLog, userId) : null };
  });

  if (messages.length === 0) {
    return NextResponse.json({ messages: [{ id: "proactive-opener", role: "enso" as const, text: PROACTIVE_OPENER_MESSAGE }] });
  }

  if (welcomeBack?.eligible) {
    const greetingText = await generateWelcomeBackMessage(getChatRouter(), welcomeBack.lastUserMessageText);
    return NextResponse.json({ messages: [...messages, { id: "welcome-back", role: "enso" as const, text: greetingText }] });
  }

  return NextResponse.json({ messages });
}
