/**
 * Ambient context batch, item 1: resolving a place the owner named (or
 * asked about nearby) to a real location, via Places API (New). Real API
 * shape verified directly (one live searchText call and one live
 * searchNearby call, both against real Johor Bahru pharmacies) before
 * this was written: `places[].displayName.text`, `places[].
 * formattedAddress`, `places[].location.{latitude,longitude}` — identical
 * shape for both endpoints.
 *
 * findPlaceByName is the primary path for the worked example (the owner's
 * mother named a specific pharmacy): resolve that NAME to coordinates,
 * then walkingRoute.ts computes the real distance from there. searchNearby
 * is the secondary "what's near X" path with no specific name given.
 */
const PLACES_TIMEOUT_MS = 8000;

export interface FoundPlace {
  name: string;
  address: string;
  latitude: number;
  longitude: number;
}

interface RawPlace {
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
}

function toFoundPlace(raw: RawPlace): FoundPlace | null {
  const name = raw.displayName?.text;
  const address = raw.formattedAddress;
  const latitude = raw.location?.latitude;
  const longitude = raw.location?.longitude;
  if (!name || !address || latitude === undefined || longitude === undefined) return null;
  return { name, address, latitude, longitude };
}

/** Resolves a place the owner named, in their own words, biased toward a real location (their own or a third party's) so "the pharmacy on Main St" resolves near the right Main St, not just any. */
export async function findPlaceByName(query: string, nearLatitude: number, nearLongitude: number, apiKey: string | undefined): Promise<FoundPlace | null> {
  if (!apiKey) return null;
  try {
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.location" },
      body: JSON.stringify({ textQuery: query, locationBias: { circle: { center: { latitude: nearLatitude, longitude: nearLongitude }, radius: 15000.0 } } }),
      signal: AbortSignal.timeout(PLACES_TIMEOUT_MS)
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { places?: RawPlace[] };
    const first = data.places?.[0];
    return first ? toFoundPlace(first) : null;
  } catch {
    return null;
  }
}

/** The secondary "what's nearby" path — no specific name, just a category (e.g. "pharmacy"). Google Places' own included-type vocabulary, not free text. */
export async function searchNearbyPlaces(includedType: string, latitude: number, longitude: number, apiKey: string | undefined): Promise<FoundPlace[] | null> {
  if (!apiKey) return null;
  try {
    const res = await fetch("https://places.googleapis.com/v1/places:searchNearby", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.location" },
      body: JSON.stringify({ includedTypes: [includedType], maxResultCount: 3, locationRestriction: { circle: { center: { latitude, longitude }, radius: 3000.0 } } }),
      signal: AbortSignal.timeout(PLACES_TIMEOUT_MS)
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { places?: RawPlace[] };
    if (!data.places) return null;
    const found = data.places.map(toFoundPlace).filter((p): p is FoundPlace => p !== null);
    return found.length > 0 ? found : null;
  } catch {
    return null;
  }
}
