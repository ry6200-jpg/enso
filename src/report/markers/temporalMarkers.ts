import type { ReportWindow, ReportWindowMessage } from "../reportWindows.js";

/**
 * Report page, Stage A (methodology Section 2.3). Exact at any message
 * length — unlike the word-class rates, these markers don't degrade on a
 * ~10-word-per-message corpus, so they're computed and displayed ahead
 * of word-class rates on the page.
 */

/** A gap of at least this long between two consecutive messages starts a new session — a named threshold, not a literature-derived constant (this project has no prior session-boundary heuristic to inherit). */
export const SESSION_GAP_MINUTES = 30;

export interface Session {
  messageCount: number;
  start: string;
  end: string;
  durationMinutes: number;
}

export interface TemporalMarkers {
  sessions: Session[];
  /** Gap in minutes between one session's end and the next session's start — length is sessions.length - 1. */
  interSessionGapsMinutes: number[];
  /** Goh-Barabási burstiness parameter, (sigma - mu) / (sigma + mu), over inter-session gaps — 0 for perfectly regular spacing, toward 1 for bursty, toward -1 for unusually regular. Null when fewer than 2 gaps exist to compute a variance from. */
  burstiness: number | null;
  /** Message count by local hour-of-day (0-23), in the timezone the caller resolved (falls back to UTC when none is available — see reportRoute.ts). */
  hourOfDayCounts: number[];
  messageLength: { meanWords: number; medianWords: number; stdevWords: number; minWords: number; maxWords: number };
  /** Type-token ratio (distinct words / total words) per window — one entry per window, same order. */
  lexicalDiversityByWindow: { windowIndex: number; typeTokenRatio: number; totalWords: number }[];
}

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z']+/g) ?? []).filter((t) => t.length > 0);
}

function computeSessions(messagesSorted: ReportWindowMessage[]): Session[] {
  if (messagesSorted.length === 0) return [];
  const gapMs = SESSION_GAP_MINUTES * 60 * 1000;
  const sessions: Session[] = [];
  let current: { start: string; end: string; count: number } = { start: messagesSorted[0]!.recordedAt, end: messagesSorted[0]!.recordedAt, count: 1 };

  for (let i = 1; i < messagesSorted.length; i++) {
    const prevTime = new Date(current.end).getTime();
    const thisTime = new Date(messagesSorted[i]!.recordedAt).getTime();
    if (thisTime - prevTime >= gapMs) {
      sessions.push({ messageCount: current.count, start: current.start, end: current.end, durationMinutes: (new Date(current.end).getTime() - new Date(current.start).getTime()) / 60000 });
      current = { start: messagesSorted[i]!.recordedAt, end: messagesSorted[i]!.recordedAt, count: 1 };
    } else {
      current.end = messagesSorted[i]!.recordedAt;
      current.count++;
    }
  }
  sessions.push({ messageCount: current.count, start: current.start, end: current.end, durationMinutes: (new Date(current.end).getTime() - new Date(current.start).getTime()) / 60000 });
  return sessions;
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stdev(xs: number[]): number {
  if (xs.length === 0) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function localHour(recordedAt: string, timezone: string): number {
  const formatted = new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: timezone }).format(new Date(recordedAt));
  return Number.parseInt(formatted, 10);
}

/** `timezone` is the ambient IANA timezone already resolved client-side (Tier 3, zero permission cost — see EN-099) — falls back to UTC only when the caller has none. */
export function computeTemporalMarkers(allMessagesSorted: ReportWindowMessage[], windows: ReportWindow[], timezone: string = "UTC"): TemporalMarkers {
  const sessions = computeSessions(allMessagesSorted);

  const interSessionGapsMinutes: number[] = [];
  for (let i = 1; i < sessions.length; i++) {
    interSessionGapsMinutes.push((new Date(sessions[i]!.start).getTime() - new Date(sessions[i - 1]!.end).getTime()) / 60000);
  }
  const burstiness =
    interSessionGapsMinutes.length >= 2
      ? (() => {
          const s = stdev(interSessionGapsMinutes);
          const m = mean(interSessionGapsMinutes);
          return s + m > 0 ? (s - m) / (s + m) : 0;
        })()
      : null;

  const hourOfDayCounts = new Array(24).fill(0) as number[];
  for (const message of allMessagesSorted) {
    let hour: number;
    try {
      hour = localHour(message.recordedAt, timezone);
    } catch {
      hour = localHour(message.recordedAt, "UTC");
    }
    hourOfDayCounts[hour]!++;
  }

  const wordCounts = allMessagesSorted.map((m) => tokenize(m.text).length);
  const messageLength = {
    meanWords: mean(wordCounts),
    medianWords: median(wordCounts),
    stdevWords: stdev(wordCounts),
    minWords: wordCounts.length > 0 ? Math.min(...wordCounts) : 0,
    maxWords: wordCounts.length > 0 ? Math.max(...wordCounts) : 0
  };

  const lexicalDiversityByWindow = windows.map((window) => {
    const tokens = window.messages.flatMap((m) => tokenize(m.text));
    const distinct = new Set(tokens).size;
    return { windowIndex: window.index, typeTokenRatio: tokens.length > 0 ? distinct / tokens.length : 0, totalWords: tokens.length };
  });

  return { sessions, interSessionGapsMinutes, burstiness, hourOfDayCounts, messageLength, lexicalDiversityByWindow };
}
