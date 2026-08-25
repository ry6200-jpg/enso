/**
 * Report page, Stage A. Windowing per enso-report-methodology.md Section
 * 1 ("Time binning"): the doc calls for 7-day sliding windows, sized that
 * way because function-word rates are unstable below ~100-200 words and
 * per-session bins are unevenly sized. This corpus (225 messages, ~10
 * words each, spanning under 2 days) is a chat rhythm, not journal
 * entries, and 7 days may be the wrong bin size for it — hence the window
 * size is read from an env var, changeable without a code change, rather
 * than a bare literal.
 *
 * Simplification, stated plainly rather than silently: windows here are
 * TUMBLING (consecutive, non-overlapping), anchored at the earliest
 * message's UTC day-start, not the doc's literal "sliding" (overlapping,
 * one new window per day). For a per-window LIST display, overlapping
 * windows would mostly duplicate each other on a corpus this size and
 * this shape (multiple near-identical windows differing by only a
 * handful of messages) — tumbling windows give one clean row per period
 * instead. Genuine overlapping/sliding windows are what the doc's own
 * Stage C (lag structure, cross-correlation between markers at a lag)
 * actually needs them for, and that stage isn't built yet.
 */

export const DEFAULT_REPORT_WINDOW_DAYS = 7;

/** Reads REPORT_WINDOW_DAYS from the environment; falls back to DEFAULT_REPORT_WINDOW_DAYS when unset, empty, or not a positive integer. Never throws — an operator typo degrades to the documented default rather than breaking the report. */
export function getReportWindowDays(): number {
  const raw = process.env.REPORT_WINDOW_DAYS;
  if (!raw || raw.trim() === "") return DEFAULT_REPORT_WINDOW_DAYS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_REPORT_WINDOW_DAYS;
  return parsed;
}

export interface ReportWindowMessage {
  id: string;
  recordedAt: string;
  text: string;
}

export interface ReportWindow {
  index: number;
  start: Date;
  /** Exclusive — a message at exactly `end` belongs to the NEXT window. */
  end: Date;
  messages: ReportWindowMessage[];
}

function dayStartUtc(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * Buckets messages (already sorted or not — sorted here defensively) into
 * consecutive `windowDays`-sized tumbling windows anchored at the
 * earliest message's UTC day-start. Returns only NON-EMPTY windows —
 * silent gaps between bursts of activity don't produce empty rows.
 */
export function computeReportWindows(messages: ReportWindowMessage[], windowDays: number = getReportWindowDays()): ReportWindow[] {
  if (messages.length === 0) return [];
  const sorted = [...messages].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
  const anchor = dayStartUtc(new Date(sorted[0]!.recordedAt));
  const windowMs = windowDays * 24 * 60 * 60 * 1000;

  const buckets = new Map<number, ReportWindowMessage[]>();
  for (const message of sorted) {
    const offset = new Date(message.recordedAt).getTime() - anchor.getTime();
    const index = Math.floor(offset / windowMs);
    if (!buckets.has(index)) buckets.set(index, []);
    buckets.get(index)!.push(message);
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, msgs]) => ({
      index,
      start: new Date(anchor.getTime() + index * windowMs),
      end: new Date(anchor.getTime() + (index + 1) * windowMs),
      messages: msgs
    }));
}
