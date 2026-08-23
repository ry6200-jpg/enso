import { NextResponse } from "next/server";
import { getChineseZodiacSign, getWesternZodiacSign } from "../../../../src/zodiac/zodiac.js";
import { getSynastryReading } from "../../../../src/zodiac/zodiacContent.js";
import { getPeopleView, getPrimaryUserBirthdate } from "../../../../src/projections/peopleView.js";
import { getChatRouter, getDailyContentCache, getStores } from "../../../../lib/serverPipeline.js";
import { authErrorResponse, requireUserId } from "../../../../lib/requireUser.js";

/**
 * EN-032, part 1: Synastry Chart against a chosen entity. The entity's
 * birthday is "tactfully collected" per the design by simply asking them
 * to mention it to Enso in ordinary conversation (not a dedicated new
 * gate — out of this phase's Part 0/1/2/3 scope) — once stated, it's an
 * ordinary attribute like any other and this route picks it up
 * automatically; until then it reports unavailable rather than guessing.
 */
export async function GET(request: Request): Promise<Response> {
  const entityId = new URL(request.url).searchParams.get("entityId");
  if (!entityId) return NextResponse.json({ error: "entityId is required" }, { status: 400 });

  let userId: string;
  try {
    userId = await requireUserId(request);
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }

  const { eventLog, projectionsDb } = getStores(userId);

  const userBirthdate = getPrimaryUserBirthdate(projectionsDb, userId);
  const userChineseSign = userBirthdate ? getChineseZodiacSign(userBirthdate) : null;
  const userWesternSign = userBirthdate ? getWesternZodiacSign(userBirthdate) : null;
  if (!userChineseSign || !userWesternSign) {
    return NextResponse.json({ available: false, reason: "your own birthdate isn't on record yet — mention it to Enso in chat" });
  }

  const person = getPeopleView(eventLog, projectionsDb, userId).find((p) => p.entityId === entityId);
  if (!person) return NextResponse.json({ error: "unknown entity" }, { status: 404 });

  const birthdateFact = person.attributes.find((a) => a.attribute === "birthdate")?.facts[0];
  const entityChineseSign = birthdateFact ? getChineseZodiacSign(birthdateFact.value) : null;
  const entityWesternSign = birthdateFact ? getWesternZodiacSign(birthdateFact.value) : null;
  if (!entityChineseSign || !entityWesternSign) {
    return NextResponse.json({ available: false, reason: `${person.name}'s birthdate isn't on record yet — mention it to Enso in chat` });
  }

  const relationshipType = person.relationships[0]?.type ?? null;

  const reading = await getSynastryReading(getDailyContentCache(), getChatRouter(), {
    userWesternSign,
    userChineseSign,
    entityName: person.name,
    entityWesternSign,
    entityChineseSign,
    relationshipType
  });

  return NextResponse.json({ available: true, entityName: person.name, userChineseSign, userWesternSign, entityChineseSign, entityWesternSign, relationshipType, reading });
}
