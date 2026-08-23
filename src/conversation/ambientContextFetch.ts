import type { RouterDecision } from "./router/routerTypes.js";
import type { AmbientLocationCandidate } from "./ambientCandidates.js";
import { geocodePlaceName } from "../location/reverseGeocode.js";
import { getCurrentWeather, type CurrentWeather } from "../location/weather.js";
import { formatLocalTime, getTimeZoneId } from "../location/timeZoneLookup.js";
import { findPlaceByName } from "../location/placesSearch.js";
import { getWalkingRoute } from "../location/walkingRoute.js";

/**
 * Ambient context batch, item 1: the actual API calls, made ONLY for
 * whatever the router's ambientContext decision named as relevant this
 * turn (already validated against real candidates by intentRouter.ts —
 * this function trusts that validation happened, same discipline as
 * resolveAttestation/resolveCorrection trusting their own callers).
 *
 * HONESTY: every call here can fail independently, and a failure means
 * that ONE data point is simply absent from the result — never an
 * estimate, never a guess presented as fact, same discipline as memory
 * honesty applied to fetched data. buildAmbientContextBlock (systemPrompt.ts)
 * only ever renders what actually resolved.
 */
export interface AmbientContextData {
  own?: { weather: CurrentWeather | null; localTime: string | null };
  thirdParty?: { name: string; weather: CurrentWeather | null; localTime: string | null };
  distance?: { placeName: string; durationMinutes: number; distanceMeters: number };
}

export interface AmbientFetchInput {
  decision: RouterDecision["ambientContext"];
  ownCoordinates: { latitude: number; longitude: number } | null;
  candidates: AmbientLocationCandidate[];
  apiKey: string | undefined;
}

export async function fetchAmbientContext(input: AmbientFetchInput): Promise<AmbientContextData> {
  if (!input.decision.relevant) return {};
  const result: AmbientContextData = {};

  if (input.decision.ownSituation && input.ownCoordinates) {
    const [weather, timeZoneId] = await Promise.all([
      getCurrentWeather(input.ownCoordinates.latitude, input.ownCoordinates.longitude, input.apiKey),
      getTimeZoneId(input.ownCoordinates.latitude, input.ownCoordinates.longitude, input.apiKey)
    ]);
    const localTime = timeZoneId ? formatLocalTime(timeZoneId) : null;
    if (weather || localTime) result.own = { weather, localTime };
  }

  // Resolved once, reused below: if a walking-distance lookup is ALSO
  // relevant this turn for the SAME third party (the worked example —
  // the owner's mother walking to a named pharmacy), the distance
  // origin must be HER location, not the owner's own.
  let thirdPartyCoordinates: { latitude: number; longitude: number } | null = null;

  if (input.decision.thirdPartyEntityId) {
    const candidate = input.candidates.find((c) => c.entityId === input.decision.thirdPartyEntityId);
    if (candidate) {
      const coords = await geocodePlaceName(candidate.location, input.apiKey);
      if (coords) {
        thirdPartyCoordinates = coords;
        const [weather, timeZoneId] = await Promise.all([
          getCurrentWeather(coords.latitude, coords.longitude, input.apiKey),
          getTimeZoneId(coords.latitude, coords.longitude, input.apiKey)
        ]);
        const localTime = timeZoneId ? formatLocalTime(timeZoneId) : null;
        if (weather || localTime) result.thirdParty = { name: candidate.name, weather, localTime };
      }
    }
  }

  if (input.decision.namedPlaceForDistance) {
    const origin = thirdPartyCoordinates ?? input.ownCoordinates;
    if (origin) {
      const place = await findPlaceByName(input.decision.namedPlaceForDistance, origin.latitude, origin.longitude, input.apiKey);
      if (place) {
        const route = await getWalkingRoute(origin.latitude, origin.longitude, place.latitude, place.longitude, input.apiKey);
        if (route) result.distance = { placeName: place.name, durationMinutes: route.durationMinutes, distanceMeters: route.distanceMeters };
      }
    }
  }

  return result;
}
