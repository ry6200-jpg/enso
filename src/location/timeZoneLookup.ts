/**
 * Ambient context batch, item 1: local time for a place the owner isn't
 * standing in. Real API shape verified directly (two live Time Zone API
 * calls — Johor Bahru and Los Angeles) before this was written:
 * `timeZoneId` (IANA, e.g. "Asia/Kuala_Lumpur"), `status`. Deliberately a
 * separate module from weather.ts even though the Weather API's own
 * response also carries a `timeZone.id` — a third-party lookup that only
 * needs local time (no weather relevance this turn) shouldn't pay for a
 * weather call it doesn't need.
 *
 * Formats the actual local time from the IANA zone id via Intl — no
 * manual offset arithmetic, and correct across DST without extra logic.
 */
const TIMEZONE_TIMEOUT_MS = 8000;

export async function getTimeZoneId(latitude: number, longitude: number, apiKey: string | undefined): Promise<string | null> {
  if (!apiKey) return null;
  try {
    const timestamp = Math.floor(Date.now() / 1000);
    const res = await fetch(`https://maps.googleapis.com/maps/api/timezone/json?location=${latitude},${longitude}&timestamp=${timestamp}&key=${apiKey}`, {
      signal: AbortSignal.timeout(TIMEZONE_TIMEOUT_MS)
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { status?: string; timeZoneId?: string };
    if (data.status !== "OK" || !data.timeZoneId) return null;
    return data.timeZoneId;
  } catch {
    return null;
  }
}

/** e.g. "2:15 PM" for the given IANA zone, as of right now. Never throws on an invalid zone id — returns null instead, since a malformed id from a failed/tampered lookup must never surface a wrong time as if it were real. */
export function formatLocalTime(timeZoneId: string, now: Date = new Date()): string | null {
  try {
    return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: timeZoneId }).format(now);
  } catch {
    return null;
  }
}
