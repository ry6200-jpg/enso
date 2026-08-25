/**
 * Chat timestamps (part 3): pure, browser-independent formatting/decision
 * logic, pulled out of app/page.tsx the same way app/lib/chatScroll.ts
 * and app/lib/transcriptDownload.ts already are, specifically so it's
 * FAST-testable. Every function here takes the timestamp as an ISO-8601
 * UTC string (the event's own `recordedAt`, stored in UTC and never
 * decoded from a ULID — see conversationHistory.ts) and a timezone
 * string (the ambient IANA timezone tier, already always-on — see
 * EN-099 / app/page.tsx's own Tier 3 timezone effect) and renders in
 * that local timezone.
 */

/** A gap of at least this long since the previous message shows an inline time badge — below it, no per-message stamp, per the "no stamps by default" requirement. */
export const INLINE_TIME_GAP_MINUTES = 60;

function localDateKey(iso: string, timezone: string): string {
  try {
    // en-CA formats as YYYY-MM-DD, a convenient sortable/comparable key — the locale choice here
    // is purely for that format, never shown to a user (all user-facing labels use en-US below).
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
  }
}

/** True for the very first message shown (nothing to compare against) or whenever the LOCAL calendar day genuinely changes from the previous message. */
export function isNewLocalDay(prevRecordedAt: string | null, recordedAt: string, timezone: string): boolean {
  if (!prevRecordedAt) return true;
  return localDateKey(prevRecordedAt, timezone) !== localDateKey(recordedAt, timezone);
}

/** "Today" / "Yesterday" / a full date — computed against `now` (injectable for tests; real callers omit it). */
export function daySeparatorLabel(recordedAt: string, timezone: string, now: Date = new Date()): string {
  const dayKey = localDateKey(recordedAt, timezone);
  if (dayKey === localDateKey(now.toISOString(), timezone)) return "Today";
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  if (dayKey === localDateKey(yesterday.toISOString(), timezone)) return "Yesterday";
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "long", day: "numeric" }).format(new Date(recordedAt));
  } catch {
    return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long", day: "numeric" }).format(new Date(recordedAt));
  }
}

/** True for the very first message shown, or when the gap since the previous message is at least INLINE_TIME_GAP_MINUTES. */
export function shouldShowInlineTime(prevRecordedAt: string | null, recordedAt: string, thresholdMinutes: number = INLINE_TIME_GAP_MINUTES): boolean {
  if (!prevRecordedAt) return true;
  const gapMs = new Date(recordedAt).getTime() - new Date(prevRecordedAt).getTime();
  return gapMs >= thresholdMinutes * 60 * 1000;
}

/** e.g. "3:45 PM" — the compact inline badge shown when shouldShowInlineTime/isNewLocalDay says to. */
export function formatInlineTime(recordedAt: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit" }).format(new Date(recordedAt));
  } catch {
    return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date(recordedAt));
  }
}

/** The full, exact timestamp — shown on hover (title attribute) or long-press, never by default. */
export function formatExactTimestamp(recordedAt: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" }).format(new Date(recordedAt));
  } catch {
    return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" }).format(new Date(recordedAt));
  }
}
