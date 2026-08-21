import { NextResponse } from "next/server";
import { getChineseZodiacSign, getWesternZodiacSign } from "../../../src/zodiac/zodiac.js";
import { getDailyZodiacCompatibility } from "../../../src/zodiac/zodiacContent.js";
import { getPrimaryUserBirthdate } from "../../../src/projections/peopleView.js";
import { getChatRouter, getDailyContentCache, getDevUserId, getStores } from "../../../lib/serverPipeline.js";

/** EN-032, part 2: Daily Zodiac Compatibility ("today's astrological relationship weather"). */
export async function GET(): Promise<Response> {
  const userId = getDevUserId();
  const { projectionsDb } = getStores();
  const birthdate = getPrimaryUserBirthdate(projectionsDb, userId);
  if (!birthdate) return NextResponse.json({ available: false });

  const chineseSign = getChineseZodiacSign(birthdate);
  const westernSign = getWesternZodiacSign(birthdate);
  if (!chineseSign || !westernSign) return NextResponse.json({ available: false });

  const reading = await getDailyZodiacCompatibility(getDailyContentCache(), getChatRouter(), chineseSign, westernSign);
  return NextResponse.json({ available: true, chineseSign, westernSign, reading });
}
