/**
 * Ambient current-location, Tier 1 (Google Geocoding API, reverse mode).
 * Verified live before wiring in (2026-08-22): $5.00/1,000 requests after a
 * 10,000/month free tier — https://developers.google.com/maps/billing-and-
 * pricing/pricing, no price difference between forward and reverse
 * geocoding. Effectively $0 at this app's real usage (once per session,
 * single user, EN-001).
 *
 * Not a port of ~/gemini_project/lib/geocoding.ts's geocodeAddressComponents
 * (a different project, different conventions) but the SAME proven
 * approach: one plain `fetch` against the same Google Geocoding endpoint,
 * parsing the same `address_components` shape — that file already
 * live-verified this exact component-priority order (locality, falling
 * back to postal_town then sublocality for a dense urban core) against a
 * real query. The only difference is the query parameter: `latlng=` for
 * reverse geocoding instead of `address=` for forward.
 *
 * CORE DISTINCTION (see enso-rebuild-requirements.md): this resolves WHERE
 * THE USER IS RIGHT NOW, never their residence. The caller discards the
 * raw coordinates immediately after calling this — this module never
 * stores or logs them, and neither does anything downstream (never an
 * event, never entity_attributes, never extraction input).
 */
const GEOCODE_TIMEOUT_MS = 8000;

export interface ReverseGeocodeResult {
  city: string | null;
  stateRegion: string | null;
  country: string | null;
}

/** Combines resolved components into a short, natural place name for the persona block — "Tokyo, Japan", "Los Angeles, California", or just "Japan" if that's all that resolved. Never a raw formatted address (too long/noisy for ambient context). */
export function formatPlaceName(result: ReverseGeocodeResult): string | null {
  const parts = [result.city, result.city ? result.stateRegion : (result.stateRegion ?? result.country)].filter((p): p is string => Boolean(p));
  if (parts.length === 0) return result.country;
  return parts.join(", ");
}

export async function reverseGeocode(latitude: number, longitude: number, apiKey: string | undefined): Promise<ReverseGeocodeResult | null> {
  if (!apiKey) return null;
  try {
    const res = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?latlng=${latitude},${longitude}&key=${apiKey}`, {
      signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS)
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      status?: string;
      results?: { address_components?: { long_name: string; types: string[] }[] }[];
    };
    const result = data.results?.[0];
    if (data.status !== "OK" || !result) return null;
    const components = result.address_components ?? [];
    const findType = (type: string) => components.find((c) => c.types.includes(type))?.long_name ?? null;
    return {
      city: findType("locality") ?? findType("postal_town") ?? findType("sublocality"),
      stateRegion: findType("administrative_area_level_1"),
      country: findType("country")
    };
  } catch {
    return null;
  }
}
