import type { RouterDecision } from "./router/routerTypes.js";
import { geocodePlaceName } from "../location/reverseGeocode.js";
import { findPlaceByName } from "../location/placesSearch.js";
import { getDrivingRoute } from "../location/drivingRoute.js";

/**
 * Ambient travel context (part 4) — the actual API calls, made ONLY for
 * what the router's travelContext decision judged relevant this turn
 * (already validated by intentRouter.ts, same trust discipline as
 * ambientContextFetch.ts's own callers). Per-turn context only: never an
 * event, never an entity attribute, excluded from extraction input, same
 * discipline as ambientContextFetch.ts's own data (see CLAUDE.md's
 * round-trip-survival maxim) — nothing here is ever persisted.
 *
 * HONESTY: a failed lookup at any step (no origin, no resolvable
 * destination, the Routes call itself failing) means no travel data
 * surfaces this turn — never an estimate, never a guess. This is what
 * makes the confabulation guard (STATED_RELATIONSHIP_FRAMING_INSTRUCTION's
 * sibling for this feature, see instructions.ts) honest: Enso is never
 * handed a plausible-sounding number to round off into "should be fine."
 */
export interface AmbientTravelData {
  /** Never shown to the user as a lookup readout — see the persona instruction for how this is actually allowed to shape a reply. */
  destinationLabel: string;
  durationMinutes: number;
  distanceMeters: number;
}

export interface AmbientTravelFetchInput {
  decision: RouterDecision["travelContext"];
  /** Origin comes from the existing ambient location tiers (the same raw coordinates ambientContextFetch.ts's ownSituation uses) — never a second origin mechanism. */
  ownCoordinates: { latitude: number; longitude: number } | null;
  /** The primary user's own resolved entity_attributes.location, if any — the fallback destination when the router named no specific place. */
  primaryResidence: string | null;
  apiKey: string | undefined;
}

export async function fetchAmbientTravelContext(input: AmbientTravelFetchInput): Promise<AmbientTravelData | null> {
  if (!input.decision.relevant) return null;
  if (!input.ownCoordinates) return null; // no origin tier resolved this turn — make no call

  let destinationLabel: string;
  let destinationCoords: { latitude: number; longitude: number } | null;

  if (input.decision.destinationHint) {
    const place = await findPlaceByName(input.decision.destinationHint, input.ownCoordinates.latitude, input.ownCoordinates.longitude, input.apiKey);
    destinationLabel = input.decision.destinationHint;
    destinationCoords = place ? { latitude: place.latitude, longitude: place.longitude } : null;
  } else if (input.primaryResidence) {
    destinationCoords = await geocodePlaceName(input.primaryResidence, input.apiKey);
    destinationLabel = input.primaryResidence;
  } else {
    return null; // no named place, no known residence — nothing to resolve, make no call
  }

  if (!destinationCoords) return null;

  const route = await getDrivingRoute(input.ownCoordinates.latitude, input.ownCoordinates.longitude, destinationCoords.latitude, destinationCoords.longitude, input.apiKey);
  if (!route) return null;

  return { destinationLabel, durationMinutes: route.durationMinutes, distanceMeters: route.distanceMeters };
}
