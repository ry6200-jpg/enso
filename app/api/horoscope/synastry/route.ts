import { NextResponse } from "next/server";
import { getChineseZodiacSign, getWesternZodiacSign } from "../../../../src/zodiac/zodiac.js";
import { getSynastryReading } from "../../../../src/zodiac/zodiacContent.js";
import { getPeopleView, getPrimaryUserBirthdate } from "../../../../src/projections/peopleView.js";
import { getChatRouter, getDailyContentCache, runReadOnlyUserSession } from "../../../../lib/serverPipeline.js";
import { authErrorResponse, requireUserId } from "../../../../lib/requireUser.js";

/**
 * EN-032, part 1: Synastry Chart against a chosen entity. The entity's
 * birthday is "tactfully collected" per the design by simply asking them
 * to mention it to Enso in ordinary conversation (not a dedicated new
 * gate — out of this phase's Part 0/1/2/3 scope) — once stated, it's an
 * ordinary attribute like any other and this route picks it up
 * automatically; until then it reports unavailable rather than guessing.
 *
 * Refresh-blank-chat batch follow-up: the reads below never write through
 * their stores, so this uses runReadOnlyUserSession (see
 * src/storage/userSession.ts) — same reduced-lock-contention reasoning as
 * app/api/history/route.ts.
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

  // Only the reads below need the per-user checkout/lock — reading
  // generation is an LLM call unrelated to this user's own files, so it
  // runs outside the checkout window rather than holding the lock for it.
  const prep = await runReadOnlyUserSession(userId, async ({ eventLog, projectionsDb }) => {
    const userBirthdate = getPrimaryUserBirthdate(projectionsDb, userId);
    const userChineseSign = userBirthdate ? getChineseZodiacSign(userBirthdate) : null;
    const userWesternSign = userBirthdate ? getWesternZodiacSign(userBirthdate) : null;
    if (!userChineseSign || !userWesternSign) return { status: "no_user_birthdate" as const };

    const person = getPeopleView(eventLog, projectionsDb, userId).find((p) => p.entityId === entityId);
    if (!person) return { status: "unknown_entity" as const };

    const birthdateFact = person.attributes.find((a) => a.attribute === "birthdate")?.facts[0];
    const entityChineseSign = birthdateFact ? getChineseZodiacSign(birthdateFact.value) : null;
    const entityWesternSign = birthdateFact ? getWesternZodiacSign(birthdateFact.value) : null;
    if (!entityChineseSign || !entityWesternSign) return { status: "no_entity_birthdate" as const, personName: person.name };

    return {
      status: "ready" as const,
      personName: person.name,
      userChineseSign,
      userWesternSign,
      entityChineseSign,
      entityWesternSign,
      relationshipType: person.relationships[0]?.type ?? null
    };
  });

  if (prep.status === "no_user_birthdate") {
    return NextResponse.json({ available: false, reason: "your own birthdate isn't on record yet — mention it to Enso in chat" });
  }
  if (prep.status === "unknown_entity") return NextResponse.json({ error: "unknown entity" }, { status: 404 });
  if (prep.status === "no_entity_birthdate") {
    return NextResponse.json({ available: false, reason: `${prep.personName}'s birthdate isn't on record yet — mention it to Enso in chat` });
  }

  const reading = await getSynastryReading(getDailyContentCache(), getChatRouter(), {
    userWesternSign: prep.userWesternSign,
    userChineseSign: prep.userChineseSign,
    entityName: prep.personName,
    entityWesternSign: prep.entityWesternSign,
    entityChineseSign: prep.entityChineseSign,
    relationshipType: prep.relationshipType
  });

  return NextResponse.json({
    available: true,
    entityName: prep.personName,
    userChineseSign: prep.userChineseSign,
    userWesternSign: prep.userWesternSign,
    entityChineseSign: prep.entityChineseSign,
    entityWesternSign: prep.entityWesternSign,
    relationshipType: prep.relationshipType,
    reading
  });
}
