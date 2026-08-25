/**
 * Pure classification of a GET /api/history response's HTTP status into
 * what app/page.tsx's history-load effect should do (stale-tab
 * investigation fix). 401 (token missing/expired/invalid,
 * UnauthenticatedError) and 403 (valid token, not on the allowlist,
 * ForbiddenError) get the SAME sign-out-and-show-the-real-server-message
 * treatment — previously only 403 was handled, so an expired token that
 * failed fast (rather than hanging) fell into the generic failure branch
 * and was logged to the console only, never shown to the user. Anything
 * else outside 2xx is a plain load failure the chat must say out loud
 * instead of silently rendering as an empty conversation.
 */
export type HistoryFetchOutcome = "authFailure" | "loadFailure" | "success";

export function classifyHistoryFetchStatus(status: number): HistoryFetchOutcome {
  if (status === 401 || status === 403) return "authFailure";
  if (status < 200 || status >= 300) return "loadFailure";
  return "success";
}
