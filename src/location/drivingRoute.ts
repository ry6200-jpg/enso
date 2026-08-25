/**
 * Ambient travel context (part 4) — real, live-traffic drive time and
 * distance. Same computeRoutes endpoint and response shape already
 * verified live this session for walkingRoute.ts (routes[0].duration is a
 * string like "1269s", NOT a number; routes[0].distanceMeters is a plain
 * number) — travelMode DRIVE and routingPreference TRAFFIC_AWARE are the
 * only differences from that call, per explicit instruction. Field-masked
 * to duration and distance only — nothing else (no polylines, no
 * turn-by-turn steps, no staticDuration).
 */
const ROUTES_TIMEOUT_MS = 8000;

export interface DrivingRoute {
  durationMinutes: number;
  distanceMeters: number;
}

function parseDurationSeconds(duration: string): number | null {
  const match = duration.match(/^(\d+(?:\.\d+)?)s$/);
  if (!match) return null;
  return Number(match[1]);
}

export async function getDrivingRoute(
  originLatitude: number,
  originLongitude: number,
  destinationLatitude: number,
  destinationLongitude: number,
  apiKey: string | undefined
): Promise<DrivingRoute | null> {
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
        travelMode: "DRIVE",
        routingPreference: "TRAFFIC_AWARE"
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
