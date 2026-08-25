export interface ZodiacSidebarData {
  available: boolean;
  date?: string;
  chinese?: { sign: string; iconUrl: string; reflection: string };
  western?: { sign: string; iconUrl: string; reflection: string };
}

/**
 * Pure: decides what a GET /api/zodiac-sidebar fetch resolves to
 * (stale-tab investigation fix). Checking `ok` here, before parsing, is
 * the actual fix — previously a non-ok response's JSON error body (e.g.
 * `{error: "Token is missing, expired, or invalid."}`) got parsed and
 * cast straight to ZodiacSidebarData; since `available` is just undefined
 * (falsy) on that shape, an auth failure silently rendered as the exact
 * same "birthdate not mentioned yet" message a real empty state shows —
 * invisible even to someone watching for it. Throwing here instead routes
 * any non-ok response through the caller's existing .catch(), which is
 * exactly where a real failure belongs.
 */
export async function resolveZodiacSidebarResponse(response: { ok: boolean; status: number; json: () => Promise<unknown> }): Promise<ZodiacSidebarData> {
  if (!response.ok) throw new Error(`GET /api/zodiac-sidebar failed (${response.status})`);
  return (await response.json()) as ZodiacSidebarData;
}
