/**
 * Pure classification of a GET /api/directory response's HTTP status
 * (EN-110), same shape and reasoning as historyFetch.ts's
 * classifyHistoryFetchStatus — three genuinely distinct conditions, never
 * collapsed into "admin vs not":
 *
 *   - "notAdmin"        (404) — the real, server-side gate (requireAdminUserId,
 *                         lib/requireUser.ts) said no. This is the control;
 *                         never retried, never treated as transient.
 *   - "notAuthenticated" (401) — no/invalid token. Distinct from "notAdmin"
 *                         so a genuinely unauthenticated caller is never
 *                         mistaken for a rejected admin check, but not
 *                         treated as a positive signal either.
 *   - "retryable"        (anything else outside 2xx — in practice 500 from
 *                         a storage-lock refusal) — infrastructure, not a
 *                         decision. Never "admin" and never "not admin";
 *                         worth trying again.
 *   - "success"          (2xx) — real data.
 *
 * Before this existed, app/page.tsx's own probe read `status !== 404` as
 * "admin" — which is TRUE for a 401 and for a 500, both wrongly read as a
 * positive admin signal (R71).
 */
export type DirectoryFetchOutcome = "notAdmin" | "notAuthenticated" | "retryable" | "success";

export function classifyDirectoryFetchStatus(status: number): DirectoryFetchOutcome {
  if (status === 404) return "notAdmin";
  if (status === 401) return "notAuthenticated";
  if (status >= 200 && status < 300) return "success";
  return "retryable";
}
