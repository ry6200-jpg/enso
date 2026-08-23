import { NextResponse } from "next/server";
import { getChineseZodiacSign, getCurrentChineseYearSign, getWesternZodiacSign, zodiacIconUrl } from "../../../src/zodiac/zodiac.js";
import { getZodiacSidebarReflection } from "../../../src/zodiac/zodiacContent.js";
import { getPrimaryUserBirthdate } from "../../../src/projections/peopleView.js";
import { getChatRouter, getDailyContentCache, runUserSession } from "../../../lib/serverPipeline.js";
import { authErrorResponse, requireUserId } from "../../../lib/requireUser.js";
import type { EventLog } from "../../../src/events/eventLog.js";

const RECENT_CONTEXT_MESSAGE_COUNT = 8;

/** The owner's last few messages, as plain text — the "something real" the sidebar reflection interprets through the sign's lens instead of writing a disconnected forecast (item 12). */
function recentUserMessageTexts(eventLog: EventLog, userId: string): string[] {
  const userMessages = eventLog
    .listForUser(userId)
    .filter((e) => e.type === "message_sent" && e.actor === "user")
    .slice(-RECENT_CONTEXT_MESSAGE_COUNT);
  return userMessages.map((e) => (e.payload as { text: string }).text);
}

/** EN-031: Western zodiac + Chinese zodiac, both derived from the user's own stated birthdate, each with its own Enso-generated (never scraped) daily reflection, cached once per day. */
export async function GET(request: Request): Promise<Response> {
  let userId: string;
  try {
    userId = await requireUserId(request);
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }

  // Only these reads need the per-user checkout/lock — reflection
  // generation below is an LLM call unrelated to this user's own files, so
  // it runs outside the checkout window rather than holding the lock.
  const prep = await runUserSession(userId, async ({ eventLog, projectionsDb }) => {
    const birthdate = getPrimaryUserBirthdate(projectionsDb, userId);
    if (!birthdate) return null;
    const chineseSign = getChineseZodiacSign(birthdate);
    const westernSign = getWesternZodiacSign(birthdate);
    if (!chineseSign || !westernSign) return null;
    return { chineseSign, westernSign, recentContext: recentUserMessageTexts(eventLog, userId) };
  });
  if (!prep) return NextResponse.json({ available: false });
  const { chineseSign, westernSign, recentContext } = prep;

  const cache = getDailyContentCache();
  const chatRouter = getChatRouter();
  const yearSign = getCurrentChineseYearSign();
  const [chineseReflection, westernReflection] = await Promise.all([
    getZodiacSidebarReflection(cache, chatRouter, "chinese", chineseSign, recentContext, yearSign),
    getZodiacSidebarReflection(cache, chatRouter, "western", westernSign, recentContext)
  ]);

  return NextResponse.json({
    available: true,
    date: new Date().toISOString().slice(0, 10),
    chinese: { sign: chineseSign, iconUrl: zodiacIconUrl(chineseSign), reflection: chineseReflection },
    western: { sign: westernSign, iconUrl: zodiacIconUrl(westernSign), reflection: westernReflection }
  });
}
