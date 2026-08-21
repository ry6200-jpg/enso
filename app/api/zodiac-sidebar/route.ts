import { NextResponse } from "next/server";
import { getChineseZodiacSign, getWesternZodiacSign, zodiacIconUrl } from "../../../src/zodiac/zodiac.js";
import { getZodiacSidebarReflection } from "../../../src/zodiac/zodiacContent.js";
import { getPrimaryUserBirthdate } from "../../../src/projections/peopleView.js";
import { getChatRouter, getDailyContentCache, getDevUserId, getStores } from "../../../lib/serverPipeline.js";

/** EN-031: Chinese zodiac + Western zodiac, both derived from the user's own stated birthdate, each with its own Enso-generated (never scraped) daily reflection, cached once per day. */
export async function GET(): Promise<Response> {
  const userId = getDevUserId();
  const { projectionsDb } = getStores();
  const birthdate = getPrimaryUserBirthdate(projectionsDb, userId);
  if (!birthdate) return NextResponse.json({ available: false });

  const chineseSign = getChineseZodiacSign(birthdate);
  const westernSign = getWesternZodiacSign(birthdate);
  if (!chineseSign || !westernSign) return NextResponse.json({ available: false });

  const cache = getDailyContentCache();
  const chatRouter = getChatRouter();
  const [chineseReflection, westernReflection] = await Promise.all([
    getZodiacSidebarReflection(cache, chatRouter, "chinese", chineseSign),
    getZodiacSidebarReflection(cache, chatRouter, "western", westernSign)
  ]);

  return NextResponse.json({
    available: true,
    date: new Date().toISOString().slice(0, 10),
    chinese: { sign: chineseSign, iconUrl: zodiacIconUrl(chineseSign), reflection: chineseReflection },
    western: { sign: westernSign, iconUrl: zodiacIconUrl(westernSign), reflection: westernReflection }
  });
}
