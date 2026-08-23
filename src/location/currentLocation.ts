import { lookupCityFromIp } from "./ipGeolocation.js";
import { formatPlaceName } from "./reverseGeocode.js";

/**
 * Ambient current-location context (see enso-rebuild-requirements.md for
 * the full CORE DISTINCTION): WHERE THE USER IS RIGHT NOW, never their
 * residence, never an event, never entity_attributes, never extraction
 * input. Resolved fresh per turn from whatever the client + request
 * happen to carry — nothing here is ever persisted.
 */
export interface CurrentLocationContext {
  /** From Tier 1 (client-geocoded) or Tier 2 (server IP lookup) — null when only Tier 3 (timezone) resolved, or nothing did. */
  placeName: string | null;
  /** Which tier actually produced this context. Null only when nothing resolved at all (no placeName AND no timezone). */
  tier: "geolocation" | "ip" | "timezone" | null;
  /** IANA timezone string (e.g. "America/Los_Angeles") — always collected client-side when available, independent of which tier produced placeName. */
  timezone: string | null;
}

export interface ClientLocationInput {
  /** Already reverse-geocoded by the client via POST /api/location before this chat turn — Tier 1. Null if geolocation was denied, unavailable, or not yet acquired this session. */
  placeName: string | null;
  /** Always sent when available — Intl.DateTimeFormat().resolvedOptions().timeZone, zero permission cost. */
  timezone: string | null;
}

/**
 * Tier priority resolution — "best available wins." Called from
 * app/api/chat/route.ts (which has the raw request, hence the IP; this
 * function itself stays a pure/testable resolver, not an HTTP handler) —
 * NEVER from chatPipeline.ts directly, since sendMessage/extraction must
 * never independently rediscover location; they only ever receive
 * whatever this function already decided.
 */
export async function resolveCurrentLocationContext(client: ClientLocationInput, requestIp: string | null): Promise<CurrentLocationContext> {
  if (client.placeName) {
    return { placeName: client.placeName, tier: "geolocation", timezone: client.timezone };
  }

  const ipResult = await lookupCityFromIp(requestIp);
  const ipPlaceName = ipResult ? formatPlaceName({ city: ipResult.city, stateRegion: ipResult.region, country: ipResult.country }) : null;
  if (ipPlaceName) {
    return { placeName: ipPlaceName, tier: "ip", timezone: client.timezone };
  }

  if (client.timezone) {
    return { placeName: null, tier: "timezone", timezone: client.timezone };
  }

  return { placeName: null, tier: null, timezone: null };
}
