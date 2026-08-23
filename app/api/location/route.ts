import { NextResponse } from "next/server";
import { formatPlaceName, reverseGeocode } from "../../../src/location/reverseGeocode.js";

/**
 * Ambient current-location, Tier 1 (see enso-rebuild-requirements.md's CORE
 * DISTINCTION). The client calls this ONCE per session, right after
 * `navigator.geolocation.getCurrentPosition` succeeds (app/page.tsx) — this
 * route holds the only place GOOGLE_MAPS_API_KEY is ever read, so the key
 * never reaches the browser. Raw coordinates are used for exactly one
 * fetch call and never written anywhere (no DB, no log) — only the
 * resolved place name is returned; the client discards the coordinates
 * immediately after receiving it.
 */
export async function POST(request: Request): Promise<Response> {
  const body = (await request.json()) as { latitude?: number; longitude?: number };
  if (typeof body.latitude !== "number" || typeof body.longitude !== "number") {
    return NextResponse.json({ error: "latitude and longitude (numbers) are required" }, { status: 400 });
  }

  const result = await reverseGeocode(body.latitude, body.longitude, process.env.GOOGLE_MAPS_API_KEY);
  const placeName = result ? formatPlaceName(result) : null;
  return NextResponse.json({ placeName });
}
