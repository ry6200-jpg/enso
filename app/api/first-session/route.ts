import { NextResponse } from "next/server";
import { PROACTIVE_OPENER_MESSAGE } from "../../../src/persona/proactiveOpener.js";
import { getDevUserId, getStores } from "../../../lib/serverPipeline.js";

/**
 * Item 13: tells the client whether this user has EVER sent a message
 * (checked against the real event log, not client/session state — a page
 * reload for a returning user must never re-trigger the opener). When
 * true, the client renders PROACTIVE_OPENER_MESSAGE as the first line in
 * the chat; the opener itself is never persisted (see proactiveOpener.ts).
 */
export async function GET(): Promise<Response> {
  const userId = getDevUserId();
  const { eventLog } = getStores();
  const hasEverMessaged = eventLog.listForUser(userId).some((e) => e.type === "message_sent" && e.actor === "user");

  return NextResponse.json({
    isFirstSession: !hasEverMessaged,
    openerText: PROACTIVE_OPENER_MESSAGE
  });
}
