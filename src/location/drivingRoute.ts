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

/**
 * EN-112 diagnostic-blind-spot fix: this function used to swallow both
 * `!res.ok` and any thrown error identically into a bare `return null`,
 * with nothing logged on either path — the same silence for "the API
 * rejected the call" as for "there's genuinely no route." That silence is
 * exactly why this feature's health was ambiguous from the outside
 * (investigation report, EN-112 Part 0): production logs had zero
 * evidence either way, so "never called" and "called and failed" looked
 * identical. Every path now logs — attempted, the HTTP status or thrown
 * error on failure, and success with the resolved duration — WITHOUT
 * changing any returned value; every `return null` below is unchanged
 * from before, only preceded by a log line. Never logs the API key or
 * the raw coordinates (location data), only outcome/status/duration.
 */
export async function getDrivingRoute(
  originLatitude: number,
  originLongitude: number,
  destinationLatitude: number,
  destinationLongitude: number,
  apiKey: string | undefined
): Promise<DrivingRoute | null> {
  if (!apiKey) return null;
  // eslint-disable-next-line no-console
  console.log("getDrivingRoute: calling computeRoutes");
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
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // eslint-disable-next-line no-console
      console.error(`getDrivingRoute: computeRoutes failed (HTTP ${res.status}): ${body.slice(0, 500)}`);
      return null;
    }
    const data = (await res.json()) as { routes?: { duration?: string; distanceMeters?: number }[] };
    const route = data.routes?.[0];
    if (!route?.duration || route.distanceMeters === undefined) {
      // eslint-disable-next-line no-console
      console.error(`getDrivingRoute: computeRoutes returned no usable route (routes array length ${data.routes?.length ?? 0})`);
      return null;
    }
    const seconds = parseDurationSeconds(route.duration);
    if (seconds === null) {
      // eslint-disable-next-line no-console
      console.error(`getDrivingRoute: could not parse duration string ${JSON.stringify(route.duration)}`);
      return null;
    }
    const durationMinutes = Math.round(seconds / 60);
    // eslint-disable-next-line no-console
    console.log(`getDrivingRoute: succeeded, durationMinutes=${durationMinutes}, distanceMeters=${route.distanceMeters}`);
    return { durationMinutes, distanceMeters: route.distanceMeters };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`getDrivingRoute: computeRoutes call threw: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
