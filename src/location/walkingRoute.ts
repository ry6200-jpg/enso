/**
 * Ambient context batch, item 1: real walking distance/time — HONESTY
 * requires a real API call here, never an estimate dressed as fact (same
 * discipline as memory honesty, applied to fetched data). Real API shape
 * verified directly (one live computeRoutes call, WALK mode, two real Los
 * Angeles points) before this was written: `routes[0].duration` (a
 * string like "1269s" — seconds, with a trailing "s", NOT a number) and
 * `routes[0].distanceMeters`. Field mask requests ONLY those two fields —
 * the real response otherwise includes full turn-by-turn steps, polylines,
 * and navigation instructions this app has no use for.
 */
const ROUTES_TIMEOUT_MS = 8000;

export interface WalkingRoute {
  durationMinutes: number;
  distanceMeters: number;
}

function parseDurationSeconds(duration: string): number | null {
  const match = duration.match(/^(\d+(?:\.\d+)?)s$/);
  if (!match) return null;
  return Number(match[1]);
}

export async function getWalkingRoute(
  originLatitude: number,
  originLongitude: number,
  destinationLatitude: number,
  destinationLongitude: number,
  apiKey: string | undefined
): Promise<WalkingRoute | null> {
  if (!apiKey) return null;
  try {
    const res = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "routes.duration,routes.distanceMeters"
      },
      body: JSON.stringify({
        origin: { location: { latLng: { latitude: originLatitude, longitude: originLongitude } } },
        destination: { location: { latLng: { latitude: destinationLatitude, longitude: destinationLongitude } } },
        travelMode: "WALK"
      }),
      signal: AbortSignal.timeout(ROUTES_TIMEOUT_MS)
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { routes?: { duration?: string; distanceMeters?: number }[] };
    const route = data.routes?.[0];
    if (!route?.duration || route.distanceMeters === undefined) return null;
    const seconds = parseDurationSeconds(route.duration);
    if (seconds === null) return null;
    return { durationMinutes: Math.round(seconds / 60), distanceMeters: route.distanceMeters };
  } catch {
    return null;
  }
}
