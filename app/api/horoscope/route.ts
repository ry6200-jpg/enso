import { NextResponse } from "next/server";
import { getChineseZodiacSign, getWesternZodiacSign } from "../../../src/zodiac/zodiac.js";
import { getDailyZodiacCompatibility } from "../../../src/zodiac/zodiacContent.js";
import { getPrimaryUserBirthdate } from "../../../src/projections/peopleView.js";
import { getChatRouter, getDailyContentCache, runUserSession } from "../../../lib/serverPipeline.js";
import { authErrorResponse, requireUserId } from "../../../lib/requireUser.js";

/** EN-032, part 2: Daily Zodiac Compatibility ("today's astrological relationship weather"). */
export async function GET(request: Request): Promise<Response> {
  let userId: string;
  try {
    userId = await requireUserId(request);
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }

  // Only the birthdate read needs the per-user checkout/lock — the reading
  // generation below is an LLM call against the shared daily-content
  // cache, unrelated to this user's own files, so it runs outside the
  // checkout window rather than holding the lock for its duration.
  const birthdate = await runUserSession(userId, async ({ projectionsDb }) => getPrimaryUserBirthdate(projectionsDb, userId));
  if (!birthdate) return NextResponse.json({ available: false });

  const chineseSign = getChineseZodiacSign(birthdate);
  const westernSign = getWesternZodiacSign(birthdate);
  if (!chineseSign || !westernSign) return NextResponse.json({ available: false });

  const reading = await getDailyZodiacCompatibility(getDailyContentCache(), getChatRouter(), chineseSign, westernSign);
  return NextResponse.json({ available: true, chineseSign, westernSign, reading });
}
