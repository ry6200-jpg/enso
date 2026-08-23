/**
 * Ambient current-location, Tier 2 (coarse IP-based city) — the fallback
 * when Tier 1 (browser geolocation, reverseGeocode.ts) was denied or
 * unavailable. ip-api.com: free for non-commercial use, no API key, no
 * signup, 45 requests/minute (verified live 2026-08-22 — irrelevant at
 * this app's real scale, EN-001). No client action needed at all: the
 * server resolves this directly from the request's own IP.
 *
 * Known local-dev limitation, worth knowing rather than silently
 * confusing: a request from localhost/a private LAN address (127.0.0.1,
 * ::1, 192.168.x.x, 10.x.x.x) has no public IP for ip-api.com to resolve —
 * this tier will simply return null in local dev, falling through to
 * Tier 3 (timezone). Real behavior only shows up once actually deployed.
 */
const IP_GEO_TIMEOUT_MS = 5000;

export interface IpGeolocationResult {
  city: string | null;
  region: string | null;
  country: string | null;
}

const PRIVATE_IP_PATTERN = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc00:|fe80:)/;

export async function lookupCityFromIp(ip: string | null): Promise<IpGeolocationResult | null> {
  if (!ip || PRIVATE_IP_PATTERN.test(ip)) return null;
  try {
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=status,city,regionName,country`, {
      signal: AbortSignal.timeout(IP_GEO_TIMEOUT_MS)
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { status?: string; city?: string; regionName?: string; country?: string };
    if (data.status !== "success") return null;
    return { city: data.city ?? null, region: data.regionName ?? null, country: data.country ?? null };
  } catch {
    return null;
  }
}
